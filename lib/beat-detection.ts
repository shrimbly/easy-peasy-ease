/**
 * Beat detection over decoded PCM.
 *
 * Pure math (no Web Audio, no DOM) so the whole pipeline is unit-testable in
 * Vitest with synthetic signals. Pipeline:
 *
 *   1. Onset-strength envelope: per-block RMS energy in two bands (broadband
 *      + low-passed "kick" band), half-wave-rectified flux, local-mean
 *      removal so slow swells don't register as onsets.
 *   2. Tempo candidates: local maxima of the envelope autocorrelation, plus
 *      their octave images inside the plausible BPM range. Autocorrelation
 *      alone must not pick the winner: swung rhythms put strong peaks at
 *      non-beat lags, so folded-score selection walks straight into dotted
 *      (3:4) aliases on real music.
 *   3. Selection: fit a comb (period sweep × phase sweep) per candidate on
 *      the FIRST HALF of the envelope; score = phase contrast × comb energy.
 *      Among near-tied candidates the SHORTEST period wins — a true beat grid
 *      keeps full comb energy at the denser reading, while dotted/subharmonic
 *      aliases only survive by cherry-picking accents. (This also settles
 *      octaves: on an even pulse, half-tempo ties the full tempo and loses.)
 *   4. Held-out validation: the chosen period must show comparable phase
 *      contrast on the SECOND HALF (grids overfit to noise don't persist),
 *      and that contrast is the reported confidence.
 */

export interface BeatAnalysis {
  /** Detected tempo in beats per minute. */
  bpm: number;
  /** Seconds per beat (60 / bpm). */
  period: number;
  /** Seconds from the start of the audio to the first beat (in [0, period)). */
  firstBeatOffset: number;
  /** 0..1 — how sharply the beat grid stands out; low values are rejected. */
  confidence: number;
}

/** Reported tempos are folded into this range (octave up/down as needed). */
const MIN_BPM = 70;
const MAX_BPM = 190;
/** Raw autocorrelation searches wider so folding can see harmonics. */
const MIN_LAG_BPM = 50;
const MAX_LAG_BPM = 220;

/** Envelope block size in samples (~11.6ms at 44.1kHz). */
const BLOCK_SIZE = 512;
/** One-pole low-pass cutoff for the kick band, Hz. */
const LOW_BAND_CUTOFF_HZ = 150;
/** Local-mean window for onset normalization, seconds. */
const LOCAL_MEAN_SECONDS = 1;
/** Analysis is capped here — tempo/phase from the first part of the track. */
const MAX_ANALYSIS_SECONDS = 90;
/** Below this there aren't enough beats to establish and validate a grid.
 *  Exported so the UI can tell "track too short" from "no steady beat". */
export const MIN_ANALYSIS_SECONDS = 8;
/** Comb search: period sweep half-width (fraction) and grid resolutions. */
const PERIOD_SEARCH_SPREAD = 0.03;
const PERIOD_SEARCH_STEPS = 61;
const PHASE_SEARCH_STEPS = 48;
/**
 * Steady signals barely move block-to-block: total upward RMS flux below this
 * fraction of total RMS level means "no onsets" (rejects tones/pads whose
 * block-RMS aliasing would otherwise fabricate a periodic envelope).
 */
const MIN_FLUX_TO_LEVEL_RATIO = 0.005;
/** How many autocorrelation peaks seed the tempo candidate set. */
const CANDIDATE_PEAKS = 12;
/** Candidates within this fraction of the best selection score are "tied";
 *  the shortest period among them wins (see module doc, step 3). */
const SELECTION_TIE_RATIO = 0.85;
/**
 * Held-out acceptance: unstructured material can fish its comb contrast up to
 * about 1.5/sqrt(K) over K beats of unseen envelope (max over phases of a
 * K-sample mean), so require the measured contrast to clear that ceiling with
 * margin. The floor guards very long windows where the ceiling goes tiny.
 */
const NOISE_CEILING_COEFF = 1.8;
const CONFIDENCE_FLOOR = 0.25;
/** The held-out contrast must also hold up against the fitted half's: real
 *  grids persist (ratio near 1), grids overfit to one half collapse. */
const HELD_OUT_CONSISTENCY = 0.75;

/**
 * Mix channels to mono (capped to the analysis window) and analyze.
 * Convenience entry point for callers holding decoded AudioBuffer channels.
 */
export function analyzeBeatsFromChannels(
  channels: Float32Array[],
  sampleRate: number
): BeatAnalysis | null {
  const first = channels[0];
  if (!first || first.length === 0 || !(sampleRate > 0)) {
    return null;
  }
  const length = Math.min(first.length, Math.floor(MAX_ANALYSIS_SECONDS * sampleRate));
  if (channels.length === 1) {
    return analyzeBeats(first.subarray(0, length), sampleRate);
  }
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      mono[i] += channel[i] ?? 0;
    }
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) {
    mono[i] *= scale;
  }
  return analyzeBeats(mono, sampleRate);
}

/** Analyze a mono signal. Returns null when no confident beat grid exists. */
export function analyzeBeats(
  samples: Float32Array,
  sampleRate: number
): BeatAnalysis | null {
  if (!(sampleRate > 0) || samples.length < MIN_ANALYSIS_SECONDS * sampleRate) {
    return null;
  }

  const capped = samples.length > MAX_ANALYSIS_SECONDS * sampleRate
    ? samples.subarray(0, Math.floor(MAX_ANALYSIS_SECONDS * sampleRate))
    : samples;

  const envelopeRate = sampleRate / BLOCK_SIZE;
  const envelope = computeOnsetEnvelope(capped, sampleRate);
  if (!envelope) {
    return null;
  }

  const grid = detectGrid(envelope, envelopeRate);
  if (!grid) {
    return null;
  }
  const { refined, confidence } = grid;

  const period = refined.periodBlocks / envelopeRate;
  // A block's onset flux fires when the transient starts inside that block;
  // on average the true attack sits half a block into it.
  const rawOffset = (refined.phaseBlocks + 0.5) / envelopeRate;
  const firstBeatOffset = positiveModulo(rawOffset, period);
  const bpm = 60 / period;

  return {
    bpm,
    period,
    firstBeatOffset,
    confidence,
  };
}

const positiveModulo = (value: number, modulus: number): number => {
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
};

/**
 * Half-wave-rectified energy flux, summed across a broadband and a low band,
 * each normalized by its own mean so kick-heavy and percussive-light material
 * weigh in equally. Returns null when the signal is effectively silent.
 */
function computeOnsetEnvelope(
  samples: Float32Array,
  sampleRate: number
): Float64Array | null {
  const blockCount = Math.floor(samples.length / BLOCK_SIZE);
  if (blockCount < 8) {
    return null;
  }

  const broadband = new Float64Array(blockCount);
  const lowBand = new Float64Array(blockCount);
  const alpha = 1 - Math.exp((-2 * Math.PI * LOW_BAND_CUTOFF_HZ) / sampleRate);
  let lowState = 0;

  for (let b = 0; b < blockCount; b++) {
    const start = b * BLOCK_SIZE;
    let energy = 0;
    let lowEnergy = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      const s = samples[start + i];
      energy += s * s;
      lowState += alpha * (s - lowState);
      lowEnergy += lowState * lowState;
    }
    broadband[b] = Math.sqrt(energy / BLOCK_SIZE);
    lowBand[b] = Math.sqrt(lowEnergy / BLOCK_SIZE);
  }

  const broadFlux = rectifiedFlux(broadband);
  const lowFlux = rectifiedFlux(lowBand);
  const broadMean = mean(broadFlux);
  const lowMean = mean(lowFlux);
  if (broadMean <= 1e-9 && lowMean <= 1e-9) {
    return null; // silence / DC — no onsets at all
  }
  // Steady tones/pads: the level is real but block-to-block movement is not.
  const levelMean = mean(broadband);
  if (levelMean <= 0 || broadMean / levelMean < MIN_FLUX_TO_LEVEL_RATIO) {
    return null;
  }

  const envelope = new Float64Array(blockCount);
  for (let b = 0; b < blockCount; b++) {
    const broad = broadMean > 1e-9 ? broadFlux[b] / broadMean : 0;
    const low = lowMean > 1e-9 ? lowFlux[b] / lowMean : 0;
    envelope[b] = broad + low;
  }

  // Remove the local mean so slow crescendos don't correlate at every lag.
  const window = Math.max(1, Math.round(LOCAL_MEAN_SECONDS * (sampleRate / BLOCK_SIZE)));
  const detrended = subtractLocalMean(envelope, window);

  // Light smoothing knits double-triggered transients back together.
  const smoothed = new Float64Array(blockCount);
  for (let b = 0; b < blockCount; b++) {
    const prev = detrended[b - 1] ?? detrended[b];
    const next = detrended[b + 1] ?? detrended[b];
    smoothed[b] = 0.25 * prev + 0.5 * detrended[b] + 0.25 * next;
  }
  return smoothed;
}

function rectifiedFlux(values: Float64Array): Float64Array {
  const flux = new Float64Array(values.length);
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    flux[i] = diff > 0 ? diff : 0;
  }
  return flux;
}

function mean(values: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
  }
  return values.length > 0 ? sum / values.length : 0;
}

function subtractLocalMean(values: Float64Array, halfWindow: number): Float64Array {
  const out = new Float64Array(values.length);
  // Prefix sums make the sliding mean O(n).
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) {
    prefix[i + 1] = prefix[i] + values[i];
  }
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(values.length, i + halfWindow + 1);
    const localMean = (prefix[end] - prefix[start]) / (end - start);
    const centered = values[i] - localMean;
    out[i] = centered > 0 ? centered : 0;
  }
  return out;
}

/**
 * Full tempo-grid detection: candidate lags from autocorrelation peaks,
 * comb-fit selection on the first half (densest near-tie wins), held-out
 * validation on the second half, final refinement on the whole envelope.
 */
function detectGrid(
  envelope: Float64Array,
  envelopeRate: number
): {
  refined: { periodBlocks: number; phaseBlocks: number };
  confidence: number;
} | null {
  const minLag = Math.max(2, Math.floor((envelopeRate * 60) / MAX_LAG_BPM));
  const maxLag = Math.min(
    envelope.length - 2,
    Math.ceil((envelopeRate * 60) / MIN_LAG_BPM)
  );
  // Need enough envelope beyond the longest lag for the products to mean much.
  if (maxLag <= minLag || envelope.length < maxLag * 2) {
    return null;
  }

  const autocorr = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = envelope.length - lag;
    for (let i = 0; i < limit; i++) {
      sum += envelope[i] * envelope[i + lag];
    }
    autocorr[lag] = sum / limit;
  }

  // Candidate lags: strongest local maxima, projected into the reportable
  // BPM window via their octave images (a strong 220 BPM tatum peak seeds
  // the 110 BPM candidate, and so on).
  const candidateMin = Math.max(minLag, Math.floor((envelopeRate * 60) / MAX_BPM));
  const candidateMax = Math.min(maxLag, Math.ceil((envelopeRate * 60) / MIN_BPM));
  const peaks: Array<[number, number]> = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (autocorr[lag] >= autocorr[lag - 1] && autocorr[lag] >= autocorr[lag + 1]) {
      peaks.push([lag, autocorr[lag]]);
    }
  }
  peaks.sort((a, b) => b[1] - a[1]);
  const candidates = new Set<number>();
  for (const [lag] of peaks.slice(0, CANDIDATE_PEAKS)) {
    for (const image of [lag, lag * 2, Math.round(lag / 2)]) {
      if (image >= candidateMin && image <= candidateMax) {
        candidates.add(image);
      }
    }
  }
  if (candidates.size === 0) {
    return null;
  }

  // Fit each candidate on the first half; score by contrast × comb energy
  // (an alias grid can be peaky OR energetic, rarely both).
  const halfIndex = Math.floor(envelope.length / 2);
  const fits: Array<{
    lag: number;
    periodBlocks: number;
    contrast: number;
    selection: number;
  }> = [];
  for (const lag of candidates) {
    const fit = combSearch(envelope, lag, 0, halfIndex);
    if (!fit) {
      continue;
    }
    const stats = phaseStats(envelope, fit.periodBlocks, 0, halfIndex);
    fits.push({
      lag,
      periodBlocks: fit.periodBlocks,
      contrast: stats.contrast,
      selection: stats.contrast * stats.best,
    });
  }
  if (fits.length === 0) {
    return null;
  }
  const bestSelection = Math.max(...fits.map((f) => f.selection));
  if (!(bestSelection > 0)) {
    return null;
  }
  const chosen = fits
    .filter((f) => f.selection >= SELECTION_TIE_RATIO * bestSelection)
    .reduce((a, b) => (b.periodBlocks < a.periodBlocks ? b : a));

  // Held-out validation on the unseen second half. The acceptance bar scales
  // with how many beats that window holds: few beats let noise fish high.
  const heldOut = phaseStats(envelope, chosen.periodBlocks, halfIndex, envelope.length);
  const confidence = heldOut.contrast;
  const heldOutBeats = (envelope.length - halfIndex) / chosen.periodBlocks;
  const requiredConfidence = Math.max(
    CONFIDENCE_FLOOR,
    NOISE_CEILING_COEFF / Math.sqrt(Math.max(1, heldOutBeats))
  );
  if (
    confidence < requiredConfidence ||
    chosen.contrast <= 0 ||
    confidence / chosen.contrast < HELD_OUT_CONSISTENCY
  ) {
    return null;
  }

  // Final grid comes from the full envelope for the best period/phase precision.
  const refined = combSearch(envelope, chosen.lag, 0, envelope.length);
  if (!refined) {
    return null;
  }
  return { refined, confidence };
}

/**
 * Mean interpolated envelope on the beat grid (period, phase), restricted to
 * grid points inside [from, to). Phase is measured from the envelope origin.
 */
function combScore(
  envelope: Float64Array,
  periodBlocks: number,
  phaseBlocks: number,
  from: number,
  to: number
): number {
  let start = phaseBlocks;
  if (start < from) {
    start += Math.ceil((from - start) / periodBlocks) * periodBlocks;
  }
  let sum = 0;
  let count = 0;
  const limit = Math.min(to, envelope.length) - 1;
  for (let t = start; t < limit; t += periodBlocks) {
    const index = Math.floor(t);
    const fraction = t - index;
    sum += envelope[index] * (1 - fraction) + envelope[index + 1] * fraction;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Joint fine search over periods around the coarse estimate and all phases,
 * scored by comb energy over envelope indices [from, to).
 */
function combSearch(
  envelope: Float64Array,
  coarsePeriodBlocks: number,
  from: number,
  to: number
): { periodBlocks: number; phaseBlocks: number; score: number } | null {
  let best: { periodBlocks: number; phaseBlocks: number; score: number } | null = null;

  for (let p = 0; p < PERIOD_SEARCH_STEPS; p++) {
    const spread = PERIOD_SEARCH_SPREAD * ((2 * p) / (PERIOD_SEARCH_STEPS - 1) - 1);
    const periodBlocks = coarsePeriodBlocks * (1 + spread);
    if (periodBlocks < 2 || periodBlocks >= (to - from) / 2) {
      continue;
    }
    for (let q = 0; q < PHASE_SEARCH_STEPS; q++) {
      const phaseBlocks = (q / PHASE_SEARCH_STEPS) * periodBlocks;
      const score = combScore(envelope, periodBlocks, phaseBlocks, from, to);
      if (!best || score > best.score) {
        best = { periodBlocks, phaseBlocks, score };
      }
    }
  }

  return best && best.score > 0 ? best : null;
}

/**
 * Phase sweep at a fixed period over [from, to): the best phase's comb score
 * and its contrast against the median phase. Contrast is high when the grid
 * is peaky (real beats), near zero when energy is spread evenly. The phase is
 * re-optimized per window so a sub-percent period error (which drifts the
 * fitted phase over a minute) doesn't punish genuinely periodic material.
 */
function phaseStats(
  envelope: Float64Array,
  periodBlocks: number,
  from: number,
  to: number
): { best: number; contrast: number } {
  const scores: number[] = [];
  for (let q = 0; q < PHASE_SEARCH_STEPS; q++) {
    const phaseBlocks = (q / PHASE_SEARCH_STEPS) * periodBlocks;
    scores.push(combScore(envelope, periodBlocks, phaseBlocks, from, to));
  }
  const best = Math.max(...scores);
  if (!(best > 0)) {
    return { best: 0, contrast: 0 };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { best, contrast: Math.max(0, Math.min(1, (best - median) / best)) };
}
