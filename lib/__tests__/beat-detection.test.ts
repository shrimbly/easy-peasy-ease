import { describe, expect, it } from 'vitest';
import { analyzeBeats, analyzeBeatsFromChannels } from '../beat-detection';

const SAMPLE_RATE = 44100;

/** Deterministic pseudo-random generator so tests never flake. */
const makeRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
};

/**
 * Synthetic music-like signal: percussive noise bursts on every beat with a
 * decaying envelope, optional accents, over a quiet noise floor.
 */
function makeClickTrack({
  bpm,
  seconds,
  firstBeatOffset = 0,
  accentEvery = 0,
  noiseFloor = 0.01,
  sampleRate = SAMPLE_RATE,
}: {
  bpm: number;
  seconds: number;
  firstBeatOffset?: number;
  accentEvery?: number;
  noiseFloor?: number;
  sampleRate?: number;
}): Float32Array {
  const random = makeRandom(1234567);
  const length = Math.floor(seconds * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = (random() * 2 - 1) * noiseFloor;
  }
  const period = 60 / bpm;
  const burstLength = Math.floor(0.03 * sampleRate);
  for (let beat = 0; ; beat++) {
    const beatTime = firstBeatOffset + beat * period;
    const start = Math.floor(beatTime * sampleRate);
    if (start >= length) break;
    const accent = accentEvery > 0 && beat % accentEvery === 0 ? 1 : 0.35;
    for (let i = 0; i < burstLength && start + i < length; i++) {
      const decay = Math.exp((-6 * i) / burstLength);
      samples[start + i] += (random() * 2 - 1) * accent * decay;
    }
  }
  return samples;
}

/** Two-onset swing pairs per beat (strong beat + weaker late partner). */
function makeSwungClickTrack({
  bpm,
  seconds,
  swing = 0.62,
  seed = 777,
}: {
  bpm: number;
  seconds: number;
  swing?: number;
  seed?: number;
}): Float32Array {
  const random = makeRandom(seed);
  const length = Math.floor(seconds * SAMPLE_RATE);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = (random() * 2 - 1) * 0.01;
  }
  const beat = 60 / bpm;
  const burstLength = Math.floor(0.025 * SAMPLE_RATE);
  for (let b = 0; ; b++) {
    const beatTime = b * beat;
    if (beatTime * SAMPLE_RATE >= length) break;
    for (const [fraction, amp] of [
      [0, 1],
      [swing, 0.5],
    ] as const) {
      const start = Math.floor((beatTime + fraction * beat) * SAMPLE_RATE);
      if (start >= length) continue;
      for (let i = 0; i < burstLength && start + i < length; i++) {
        samples[start + i] += (random() * 2 - 1) * amp * Math.exp((-6 * i) / burstLength);
      }
    }
  }
  return samples;
}

/**
 * Dense swung 16ths with accented beats — the envelope that lured the old
 * folded-autocorrelation selection into a dotted (3:4) tempo alias, cutting
 * two of every three section boundaries off the beat.
 */
function makeDenseSwingTrack({
  bpm,
  seconds,
  seed = 555,
}: {
  bpm: number;
  seconds: number;
  seed?: number;
}): Float32Array {
  const random = makeRandom(seed);
  const length = Math.floor(seconds * SAMPLE_RATE);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = (random() * 2 - 1) * 0.01;
  }
  const beat = 60 / bpm;
  const burstLength = Math.floor(0.02 * SAMPLE_RATE);
  for (let b = 0; ; b++) {
    const beatTime = b * beat;
    if (beatTime * SAMPLE_RATE >= length) break;
    for (const [fraction, amp] of [
      [0, 1],
      [0.29, 0.3],
      [0.5, b % 2 ? 0.75 : 0.45],
      [0.79, 0.3],
    ] as const) {
      const start = Math.floor((beatTime + fraction * beat) * SAMPLE_RATE);
      if (start >= length) continue;
      for (let i = 0; i < burstLength && start + i < length; i++) {
        samples[start + i] += (random() * 2 - 1) * amp * Math.exp((-6 * i) / burstLength);
      }
    }
  }
  return samples;
}

/** The reported tempo may sit an octave off; cuts land on beats either way. */
const expectOnBeatGrid = (bpm: number, target: number) => {
  const onGrid = [1, 2, 0.5].some(
    (m) => Math.abs(bpm - target * m) < target * m * 0.02
  );
  expect(onGrid, `${bpm} not on the ${target} beat grid`).toBe(true);
};

describe('analyzeBeats', () => {
  it('detects the tempo and phase of a 120 BPM click track', () => {
    const samples = makeClickTrack({ bpm: 120, seconds: 30, firstBeatOffset: 0.25 });
    const result = analyzeBeats(samples, SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(result!.bpm).toBeGreaterThan(119.5);
    expect(result!.bpm).toBeLessThan(120.5);
    expect(result!.period).toBeCloseTo(60 / result!.bpm, 10);
    expect(result!.firstBeatOffset).toBeGreaterThanOrEqual(0);
    expect(result!.firstBeatOffset).toBeLessThan(result!.period);
    expect(Math.abs(result!.firstBeatOffset - 0.25)).toBeLessThan(0.035);
    expect(result!.confidence).toBeGreaterThan(0.3);
  });

  it('detects a slow 84 BPM groove', () => {
    const samples = makeClickTrack({ bpm: 84, seconds: 30 });
    const result = analyzeBeats(samples, SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 84)).toBeLessThan(0.5);
  });

  it('detects a fast 174 BPM track without halving the tempo', () => {
    const samples = makeClickTrack({ bpm: 174, seconds: 30 });
    const result = analyzeBeats(samples, SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 174)).toBeLessThan(1);
  });

  it('handles a non-integer tempo', () => {
    const samples = makeClickTrack({ bpm: 127.4, seconds: 40 });
    const result = analyzeBeats(samples, SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 127.4)).toBeLessThan(0.6);
  });

  it('works at 48kHz', () => {
    const samples = makeClickTrack({ bpm: 110, seconds: 30, sampleRate: 48000 });
    const result = analyzeBeats(samples, 48000);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 110)).toBeLessThan(0.5);
  });

  it('folds eighth-note pulses onto the accented quarter-note tempo', () => {
    // Pulses at 240 BPM with strong accents every second pulse = 120 BPM feel.
    const samples = makeClickTrack({ bpm: 240, seconds: 30, accentEvery: 2 });
    const result = analyzeBeats(samples, SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 120)).toBeLessThan(0.5);
  });

  it('locks onto the beat of swung rhythms', () => {
    const track92 = makeSwungClickTrack({ bpm: 92, seconds: 30 });
    const result92 = analyzeBeats(track92, SAMPLE_RATE);
    expect(result92).not.toBeNull();
    expect(Math.abs(result92!.bpm - 92)).toBeLessThan(0.5);

    const track140 = makeSwungClickTrack({ bpm: 140, seconds: 30, seed: 31 });
    const result140 = analyzeBeats(track140, SAMPLE_RATE);
    expect(result140).not.toBeNull();
    expect(Math.abs(result140!.bpm - 140)).toBeLessThan(0.5);
  });

  it('does not fall into dotted (3:4) aliases on dense swung material', () => {
    // Regression for a real-world failure: swung hats put autocorrelation
    // peaks at non-beat lags, and a dotted grid can out-score the beat grid
    // unless near-ties resolve toward the denser (shorter-period) reading.
    for (const [bpm, seed] of [
      [96, 555],
      [132, 12321],
    ] as const) {
      const samples = makeDenseSwingTrack({ bpm, seconds: 40, seed });
      const result = analyzeBeats(samples, SAMPLE_RATE);
      expect(result).not.toBeNull();
      expectOnBeatGrid(result!.bpm, bpm);
    }
  });

  it('handles a short 9-second loop', () => {
    const samples = makeClickTrack({ bpm: 100, seconds: 9 });
    const result = analyzeBeats(samples, SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 100)).toBeLessThan(0.5);
  });

  it('returns null for silence', () => {
    const samples = new Float32Array(30 * SAMPLE_RATE);
    expect(analyzeBeats(samples, SAMPLE_RATE)).toBeNull();
  });

  it('returns null for a constant tone', () => {
    const samples = new Float32Array(30 * SAMPLE_RATE);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.5;
    }
    expect(analyzeBeats(samples, SAMPLE_RATE)).toBeNull();
  });

  it('returns null for unstructured noise, including short windows', () => {
    // Short tracks have few held-out beats, letting noise fish its comb
    // contrast high — the length-scaled acceptance bar must hold them out.
    for (const [seed, seconds] of [
      [42, 30],
      [99, 12],
      [864, 10],
      [456, 9],
      [7, 60],
    ] as const) {
      const random = makeRandom(seed);
      const samples = new Float32Array(seconds * SAMPLE_RATE);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = (random() * 2 - 1) * 0.5;
      }
      expect(analyzeBeats(samples, SAMPLE_RATE), `noise seed ${seed}`).toBeNull();
    }
  });

  it('returns null for audio shorter than the minimum window', () => {
    const samples = makeClickTrack({ bpm: 120, seconds: 2 });
    expect(analyzeBeats(samples, SAMPLE_RATE)).toBeNull();
  });
});

describe('analyzeBeatsFromChannels', () => {
  it('averages stereo channels before analysis', () => {
    const left = makeClickTrack({ bpm: 96, seconds: 30 });
    const right = makeClickTrack({ bpm: 96, seconds: 30 });
    const result = analyzeBeatsFromChannels([left, right], SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 96)).toBeLessThan(0.5);
  });

  it('returns null for empty input', () => {
    expect(analyzeBeatsFromChannels([], SAMPLE_RATE)).toBeNull();
    expect(analyzeBeatsFromChannels([new Float32Array(0)], SAMPLE_RATE)).toBeNull();
  });
});
