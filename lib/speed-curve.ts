/**
 * Speed Curve Utility
 * Implements warpTime function for ease-in-out speed curves
 * Now supports 30+ easing functions from the easing-functions library
 */

import { easing, type EasingFunction, resolveEasing } from './easing-functions';

const INVERSE_TOLERANCE = 1e-6;
const INVERSE_MAX_ITERATIONS = 32;
const MONOTONICITY_SAMPLES = 256;
const MONOTONICITY_TOLERANCE = 1e-6;

const inverseCache = new WeakMap<EasingFunction, EasingFunction | null>();
const monotonicityCache = new WeakMap<EasingFunction, boolean>();
const warnedNonMonotonic = new WeakSet<EasingFunction>();

export interface EasedSampleParams {
  /** Absolute track time (s) where this section begins. */
  spanStart: number;
  /** Absolute track time (s) where this section ends. */
  spanEnd: number;
  /** Absolute end timestamp (s) of the whole track — a hard upper clamp. */
  trackEnd: number;
  /** Easing function mapping output progress -> source progress, both [0, 1]. */
  easing: EasingFunction;
  /** Number of output frame slots to emit. */
  outputFrameCount: number;
  /** Output frame interval (s), used to size the end-of-section safety clamp. */
  minFrameInterval: number;
}

/**
 * Precompute, for each output frame slot, the source timestamp the easing
 * curve calls for within a section [spanStart, spanEnd]. This is the heart of
 * the output-driven retimer: output progress p in [0, 1] samples the source at
 * `spanStart + easing(p) * (spanEnd - spanStart)`.
 *
 * Timestamps are clamped inside the last real frame of the section (and never
 * past the track end) so end-of-section requests can't fall off the track —
 * the same edge mitigation the whole-clip path relies on. Passing the full
 * clip (spanStart = firstTimestamp, spanEnd = trackEnd) reproduces the
 * original whole-clip behaviour exactly; a sub-range yields one eased section.
 */
export function buildEasedSourceTimestamps(params: EasedSampleParams): number[] {
  const { spanStart, spanEnd, trackEnd, easing: easingFunc, outputFrameCount, minFrameInterval } =
    params;
  const frames = Math.max(1, Math.floor(outputFrameCount));
  const span = Math.max(0, spanEnd - spanStart);
  const epsilon = Math.min(0.001, minFrameInterval / 2);
  const endClamp = Math.max(spanStart, Math.min(spanEnd, trackEnd) - epsilon);

  const timestamps: number[] = [];
  for (let slot = 0; slot < frames; slot++) {
    const outputProgress = frames > 1 ? slot / (frames - 1) : 0;
    const sourceProgress = easingFunc(outputProgress);
    const sourceTime = spanStart + sourceProgress * span;
    timestamps.push(Math.min(Math.max(sourceTime, spanStart), endClamp));
  }
  return timestamps;
}

/** Small tolerance for floating-point timestamp comparisons (seconds). */
const TIMESTAMP_EPSILON = 1e-9;

/**
 * Merge monotonic eased `desired` timestamps against a monotonic forward stream
 * of `sourceTimestamps` (the start timestamps of the decoded source frames, in
 * presentation order). For each desired time, returns the index of the source
 * frame to display: the last frame whose start timestamp is <= the desired
 * time, clamped to the first frame for desired times before it.
 *
 * This is the pure form of the streaming forward-decode merge in
 * useApplySpeedCurve — it lets the retimer emit real frames for every output
 * slot from a single in-order decode pass (which drains the decoder to EOS,
 * unlike per-timestamp seeking) instead of holding a frozen frame when the
 * decoder drops end-of-range frames (the Android MediaCodec failure mode).
 * Returns -1 for every slot when there are no source frames.
 */
export function mapDesiredToSourceIndices(
  sourceTimestamps: number[],
  desired: number[]
): number[] {
  const result: number[] = [];
  if (sourceTimestamps.length === 0) {
    return desired.map(() => -1);
  }
  let i = 0;
  for (const d of desired) {
    while (i + 1 < sourceTimestamps.length && sourceTimestamps[i + 1] <= d + TIMESTAMP_EPSILON) {
      i++;
    }
    result.push(i);
  }
  return result;
}


function isMonotonicIncreasing(func: EasingFunction): boolean {
  const cached = monotonicityCache.get(func);
  if (cached !== undefined) {
    return cached;
  }

  let prev = func(0);
  for (let i = 1; i <= MONOTONICITY_SAMPLES; i++) {
    const value = func(i / MONOTONICITY_SAMPLES);
    if (value + MONOTONICITY_TOLERANCE < prev) {
      monotonicityCache.set(func, false);
      return false;
    }
    prev = value;
  }

  monotonicityCache.set(func, true);
  return true;
}

function invertEasingValue(target: number, func: EasingFunction): number {
  if (target <= INVERSE_TOLERANCE) {
    return 0;
  }
  if (target >= 1 - INVERSE_TOLERANCE) {
    return 1;
  }

  let low = 0;
  let high = 1;
  let mid = 0.5;

  for (let i = 0; i < INVERSE_MAX_ITERATIONS; i++) {
    mid = (low + high) / 2;
    const value = func(mid);
    const diff = value - target;

    if (Math.abs(diff) <= INVERSE_TOLERANCE) {
      break;
    }

    if (diff < 0) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return Math.min(1, Math.max(0, mid));
}

function getInverseEasing(func: EasingFunction): EasingFunction | null {
  if (inverseCache.has(func)) {
    return inverseCache.get(func)!;
  }

  if (!isMonotonicIncreasing(func)) {
    inverseCache.set(func, null);
    return null;
  }

  const inverse: EasingFunction = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    return invertEasingValue(clamped, func);
  };

  inverseCache.set(func, inverse);
  return inverse;
}

function mapTimeWithEasing(normalizedTime: number, func: EasingFunction): number {
  const inverse = getInverseEasing(func);
  if (!inverse) {
    if (!warnedNonMonotonic.has(func)) {
      console.warn(
        `Easing function "${func.name ?? 'anonymous'}" is not monotonic. Falling back to direct mapping - timing may feel inverted.`
      );
      warnedNonMonotonic.add(func);
    }
    return func(normalizedTime);
  }

  return inverse(normalizedTime);
}

/**
 * Maps original video timestamps to warped timestamps using any easing function
 *
 * @param originalTime - Original timestamp in seconds (0 to inputDuration)
 * @param inputDuration - Input video duration in seconds (default: 5)
 * @param outputDuration - Output video duration in seconds (default: 1.5)
 * @param easingFunction - Easing function to use (default: easeInOutCubic) or function name string
 * @returns Warped timestamp for the output video
 *
 * @example
 * // Convert 2.5s from a 5s video to a 1.5s video with ease-in-out cubic
 * const warpedTime = warpTime(2.5, 5, 1.5, easing.easeInOutCubic); // Returns 0.75
 *
 * @example
 * // Using a preset easing function by name
 * const warpedTime = warpTime(2.5, 5, 1.5, 'easeInOutCubic'); // Also returns 0.75
 */
export function warpTime(
  originalTime: number,
  inputDuration: number = 5,
  outputDuration: number = 1.5,
  easingFunction: EasingFunction | string = easing.easeInOutCubic
): number {
  // Resolve easing function if string is provided
  const easingFunc = typeof easingFunction === 'string'
    ? resolveEasing(easingFunction)
    : easingFunction;

  // Degenerate inputs produce a degenerate (but finite) mapping
  if (
    !Number.isFinite(inputDuration) || inputDuration <= 0 ||
    !Number.isFinite(outputDuration) || outputDuration <= 0
  ) {
    return 0;
  }

  // Normalize original time to 0-1 range
  const t = originalTime / inputDuration;

  // Clamp t to [0, 1] to handle floating point errors
  const clamped = Math.max(0, Math.min(1, t));

  // Apply inverse easing so that ease-in curves slow the start instead of accelerating it
  const eased = mapTimeWithEasing(clamped, easingFunc);

  // Scale to output duration
  return eased * outputDuration;
}

/**
 * Cubic ease-in-out curve (smoother than quadratic)
 * Use this for a more gradual acceleration/deceleration
 * @deprecated Use warpTime with easing.easeInOutCubic instead
 */
export function warpTimeCubic(
  originalTime: number,
  inputDuration: number = 5,
  outputDuration: number = 1.5
): number {
  return warpTime(originalTime, inputDuration, outputDuration, easing.easeInOutCubic);
}

/**
 * Quartic ease-in-out curve (sharper than cubic)
 * Use this for a dramatic sharp acceleration/deceleration effect
 * Slow at start/end, very fast in the middle
 * @deprecated Use warpTime with easing.easeInOutQuart instead
 */
export function warpTimeQuartic(
  originalTime: number,
  inputDuration: number = 5,
  outputDuration: number = 1.5
): number {
  return warpTime(originalTime, inputDuration, outputDuration, easing.easeInOutQuart);
}

/**
 * Linear time mapping (no speed curve - constant speed)
 * Use this as a baseline for comparison
 * @deprecated Use warpTime with easing.linear instead
 */
export function warpTimeLinear(
  originalTime: number,
  inputDuration: number = 5,
  outputDuration: number = 1.5
): number {
  return warpTime(originalTime, inputDuration, outputDuration, easing.linear);
}

/**
 * Calculate the duration of a frame after warping
 *
 * @param originalStart - Original frame start time in seconds
 * @param originalDuration - Original frame duration in seconds
 * @param inputDuration - Total input video duration in seconds
 * @param outputDuration - Total output video duration in seconds
 * @param easingFunction - Easing function to use (default: easeInOutCubic)
 * @returns Warped frame duration in seconds
 *
 * @example
 * // Frame at 2.5s with 0.033s duration (30fps)
 * const warpedDur = calculateWarpedDuration(2.5, 0.033, 5, 1.5, easing.easeInOutCubic);
 * // The warped frame will have a different duration based on the curve
 */
export function calculateWarpedDuration(
  originalStart: number,
  originalDuration: number,
  inputDuration: number = 5,
  outputDuration: number = 1.5,
  easingFunction: EasingFunction | string = easing.easeInOutCubic
): number {
  const warpedStart = warpTime(originalStart, inputDuration, outputDuration, easingFunction);
  const warpedEnd = warpTime(
    originalStart + originalDuration,
    inputDuration,
    outputDuration,
    easingFunction
  );
  return warpedEnd - warpedStart;
}

/**
 * Validate that a warp time function produces valid output
 */
export function validateWarpFunction(
  easingFunction: EasingFunction | string = easing.easeInOutCubic,
  inputDuration: number = 5,
  outputDuration: number = 1.5,
  tolerance: number = 0.001
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!Number.isFinite(inputDuration) || inputDuration <= 0) {
    return { valid: false, errors: ['inputDuration must be a positive, finite number'] };
  }
  if (!Number.isFinite(outputDuration) || outputDuration <= 0) {
    return { valid: false, errors: ['outputDuration must be a positive, finite number'] };
  }

  // Check start point
  const startWarp = warpTime(0, inputDuration, outputDuration, easingFunction);
  if (Math.abs(startWarp - 0) > tolerance) {
    errors.push(`Start point should be 0, got ${startWarp}`);
  }

  // Check end point
  const endWarp = warpTime(inputDuration, inputDuration, outputDuration, easingFunction);
  if (Math.abs(endWarp - outputDuration) > tolerance) {
    errors.push(`End point should be ${outputDuration}, got ${endWarp}`);
  }

  // Check monotonicity (always increasing)
  let prevWarp = 0;
  for (let t = 0; t <= inputDuration; t += inputDuration / 100) {
    const warp = warpTime(t, inputDuration, outputDuration, easingFunction);
    if (warp < prevWarp) {
      errors.push(`Monotonicity violation at t=${t.toFixed(2)}: ${warp} < ${prevWarp}`);
      break;
    }
    prevWarp = warp;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Generate statistics about the warp curve
 */
export function analyzeWarpCurve(
  easingFunction: EasingFunction | string = easing.easeInOutCubic,
  inputDuration: number = 5,
  outputDuration: number = 1.5,
  samples: number = 100
): {
  speedMultipliers: number[];
  minSpeed: number;
  maxSpeed: number;
  avgSpeed: number;
} {
  const speedMultipliers: number[] = [];
  const averageSpeed = inputDuration / outputDuration;

  for (let i = 0; i < samples; i++) {
    const t1 = (i / samples) * inputDuration;
    const t2 = ((i + 1) / samples) * inputDuration;

    const warp1 = warpTime(t1, inputDuration, outputDuration, easingFunction);
    const warp2 = warpTime(t2, inputDuration, outputDuration, easingFunction);

    const inputSegmentDuration = t2 - t1;
    const outputSegmentDuration = warp2 - warp1;
    // Relative speed compared to linear compression (1.0 == same as linear remap)
    const absoluteSpeed = inputSegmentDuration / (outputSegmentDuration + 1e-10); // playback speed vs real time
    const speedMultiplier = absoluteSpeed / averageSpeed;

    speedMultipliers.push(speedMultiplier);
  }

  const minSpeed = Math.min(...speedMultipliers);
  const maxSpeed = Math.max(...speedMultipliers);
  const avgSpeed = speedMultipliers.reduce((a, b) => a + b, 0) / speedMultipliers.length;

  return {
    speedMultipliers,
    minSpeed,
    maxSpeed,
    avgSpeed,
  };
}
