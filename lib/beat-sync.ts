/**
 * Beat-grid math for snapping section durations and audio offset so section
 * boundaries land on beats of an analyzed track.
 *
 * The renderer rounds every section to whole frames (see useApplySpeedCurve),
 * so naive "multiple of the beat interval" durations would drift off the grid
 * by up to half a frame per section, accumulating across the video. Durations
 * are therefore quantized so each CUMULATIVE boundary sits on the output frame
 * closest to its beat — frame-exact values round-trip through the renderer
 * unchanged and the error never accumulates.
 *
 * Quantization uses the COARSEST output rate (PREVIEW_FPS = 30): every render
 * tier runs at 30 or 60 fps, and an n/30 duration is exactly 2n frames at 60,
 * so the round-trip is exact at both rates. Quantizing at 60 instead would
 * make odd frame counts round upward at 30fps — a one-directional error that
 * accumulates across sections (preview quality is the default).
 */

import { PREVIEW_FPS } from './speed-curve-config';

/** Sections can end on every beat, every 2nd beat, or every 4th beat. */
export type BeatSubdivision = 1 | 2 | 4;
export const BEAT_SUBDIVISIONS: readonly BeatSubdivision[] = [1, 2, 4];

export interface BeatGrid {
  /** Seconds per beat. */
  period: number;
  /** Seconds from the start of the audio to the first beat. */
  firstBeatOffset: number;
}

const positiveModulo = (value: number, modulus: number): number => {
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
};

/**
 * Snap each duration to the nearest whole number of `beatsPerSection` beats
 * (at least one), then re-quantize so every cumulative boundary lands on the
 * output frame nearest its beat time.
 */
export function snapDurationsToBeatGrid(
  durations: number[],
  bpm: number,
  beatsPerSection: BeatSubdivision,
  fps: number = PREVIEW_FPS
): number[] {
  if (!(bpm > 0) || !(fps > 0)) {
    return [...durations];
  }
  const interval = (60 / bpm) * beatsPerSection;
  const snapped: number[] = [];
  let intervalCount = 0;
  let previousBoundaryFrames = 0;
  for (const duration of durations) {
    intervalCount += Math.max(1, Math.round(duration / interval));
    const boundaryFrames = Math.round(intervalCount * interval * fps);
    snapped.push((boundaryFrames - previousBoundaryFrames) / fps);
    previousBoundaryFrames = boundaryFrames;
  }
  return snapped;
}

/**
 * Shift the audio offset left by less than one beat so that a beat lands
 * exactly at video time 0 (making beat times in the video multiples of the
 * period). Always shifts left — nudging audio earlier trims a sliver of
 * intro, whereas shifting right would insert dead air at the loop start.
 */
export function alignOffsetToBeatGrid(offset: number, grid: BeatGrid): number {
  if (!(grid.period > 0)) {
    return offset;
  }
  const phase = positiveModulo(offset + grid.firstBeatOffset, grid.period);
  // An already-aligned offset can carry float error that leaves its phase at
  // period - epsilon (or exactly period, after positiveModulo's addition
  // rounds); subtracting that would trim a whole extra beat on re-alignment.
  if (grid.period - phase < 1e-9) {
    return offset;
  }
  return offset - phase;
}

/**
 * Move `offset` to the NEAREST beat-aligned position (at most half a beat in
 * either direction) — used to keep a manual waveform drag on the grid while
 * snapping is active, so the drag feels magnetic instead of breaking sync.
 */
export function quantizeOffsetToNearestBeat(offset: number, grid: BeatGrid): number {
  if (!(grid.period > 0)) {
    return offset;
  }
  const aligned = alignOffsetToBeatGrid(offset, grid);
  return offset - aligned > grid.period / 2 ? aligned + grid.period : aligned;
}

/**
 * Where beats fall on the video timeline: firstBeatVideoTime + k * period for
 * k ≥ 0. Callers render ticks from this anchor (e.g. as a repeating pattern).
 */
export function firstBeatVideoTime(grid: BeatGrid, offset: number): number {
  return offset + grid.firstBeatOffset;
}

/**
 * Anchor for emphasized ticks: the beat nearest video time 0, i.e. where the
 * first section boundary group starts once the offset is beat-aligned.
 */
export function emphasisAnchorVideoTime(grid: BeatGrid, offset: number): number {
  if (!(grid.period > 0)) {
    return 0;
  }
  const first = firstBeatVideoTime(grid, offset);
  return first + Math.round(-first / grid.period) * grid.period;
}
