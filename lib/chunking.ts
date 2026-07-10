/**
 * Chunking logic for "Split a video" mode.
 *
 * One long upload is divided into contiguous **sections** by a set of interior
 * **split points** (times, in seconds, strictly between 0 and the source
 * duration). Each section is then retimed with its own ease curve — the same
 * per-segment machinery the multi-clip "Stitch clips" mode uses.
 *
 * Everything here is pure and unit-tested. `buildSectionSegments` is the one
 * side-effecting helper (it mints object URLs) and takes the URL factory as an
 * argument so it stays testable, matching the factory-injection pattern used
 * by lib/audio-prep.
 */

import type { TransitionVideo, VideoEncodeCapability } from './types';
import type { Rotation } from 'mediabunny';
import { DEFAULT_OUTPUT_DURATION, DEFAULT_EASING } from './speed-curve-config';
import { getPresetBezier } from './easing-presets';

/** Shortest section we allow. Anything smaller retimes to a jittery stub. */
export const MIN_SECTION_DURATION = 0.3;

/** Upper bound on sections so a tiny section length can't melt the browser. */
export const MAX_SECTIONS = 40;

/** Default length of each auto-generated section, in seconds. */
export const DEFAULT_SECTION_LENGTH = 5;

/** A contiguous slice of the source, in source presentation seconds. */
export interface Section {
  index: number;
  start: number;
  end: number;
  duration: number;
}

const isFinitePositive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Normalise a set of interior split times against a source duration: drop
 * non-finite values, clamp into the open interval, sort ascending, and remove
 * any split that sits within `minGap` of a neighbour or of the 0/duration
 * boundaries (so every resulting section is at least `minGap` long).
 */
export function sanitizeSplitTimes(
  sourceDuration: number,
  splitTimes: number[],
  minGap: number = MIN_SECTION_DURATION
): number[] {
  if (!isFinitePositive(sourceDuration)) {
    return [];
  }

  const sorted = splitTimes
    .filter((t) => Number.isFinite(t))
    .map((t) => clamp(t, 0, sourceDuration))
    .sort((a, b) => a - b);

  const result: number[] = [];
  let lastBoundary = 0; // start of the current (still-open) section
  for (const t of sorted) {
    // Keep the split only if it leaves room before it AND could still leave
    // room after it (at least one min-length section remains at the tail).
    if (t - lastBoundary >= minGap && sourceDuration - t >= minGap) {
      result.push(t);
      lastBoundary = t;
    }
  }
  return result;
}

/**
 * Turn interior split times into contiguous sections covering [0, duration].
 * Split times are sanitised first, so the output always has valid,
 * non-overlapping sections (at least one when the source is non-empty).
 */
export function deriveSections(
  sourceDuration: number,
  splitTimes: number[],
  minGap: number = MIN_SECTION_DURATION
): Section[] {
  if (!isFinitePositive(sourceDuration)) {
    return [];
  }

  const splits = sanitizeSplitTimes(sourceDuration, splitTimes, minGap);
  const boundaries = [0, ...splits, sourceDuration];
  const sections: Section[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    sections.push({ index: i, start, end, duration: end - start });
  }
  return sections;
}

/**
 * How many sections a given section length yields for a source. Derived from
 * the actual splits `computeEvenSplitTimes` would produce (so the live UI
 * preview can't disagree with "Split evenly" — e.g. when a tiny trailing
 * remainder is folded into the previous section). Respects MAX_SECTIONS.
 */
export function sectionCountForLength(
  sourceDuration: number,
  sectionLength: number
): number {
  if (!isFinitePositive(sourceDuration) || !isFinitePositive(sectionLength)) {
    return 0;
  }
  return deriveSections(sourceDuration, computeEvenSplitTimes(sourceDuration, sectionLength)).length;
}

/**
 * Evenly spaced interior split times for a fixed section length. A short
 * trailing remainder (< minGap) is folded into the previous section rather
 * than left as a stub, and the total section count is capped at MAX_SECTIONS.
 */
export function computeEvenSplitTimes(
  sourceDuration: number,
  sectionLength: number,
  minGap: number = MIN_SECTION_DURATION
): number[] {
  if (!isFinitePositive(sourceDuration) || !isFinitePositive(sectionLength)) {
    return [];
  }

  // Cap the section length from below so we never exceed MAX_SECTIONS.
  const minLength = sourceDuration / MAX_SECTIONS;
  const length = Math.max(sectionLength, minLength);

  const splits: number[] = [];
  for (let t = length; t < sourceDuration - 1e-6; t += length) {
    // Fold a too-short tail into the final section.
    if (sourceDuration - t < minGap) {
      break;
    }
    splits.push(Number(t.toFixed(6)));
  }
  return sanitizeSplitTimes(sourceDuration, splits, minGap);
}

/**
 * Interior split times that divide the source into `count` equal sections.
 */
export function computeSplitTimesByCount(
  sourceDuration: number,
  count: number,
  minGap: number = MIN_SECTION_DURATION
): number[] {
  if (!isFinitePositive(sourceDuration) || !Number.isFinite(count)) {
    return [];
  }
  const sections = Math.max(1, Math.min(MAX_SECTIONS, Math.floor(count)));
  if (sections <= 1) {
    return [];
  }
  const step = sourceDuration / sections;
  const splits: number[] = [];
  for (let i = 1; i < sections; i++) {
    splits.push(Number((step * i).toFixed(6)));
  }
  return sanitizeSplitTimes(sourceDuration, splits, minGap);
}

/**
 * Whether a split at time `t` can be inserted without producing a section
 * shorter than `minGap` on either side of it.
 */
export function canInsertSplit(
  splitTimes: number[],
  t: number,
  sourceDuration: number,
  minGap: number = MIN_SECTION_DURATION
): boolean {
  if (!isFinitePositive(sourceDuration) || !Number.isFinite(t)) {
    return false;
  }
  if (t <= 0 || t >= sourceDuration) {
    return false;
  }
  if (deriveSections(sourceDuration, splitTimes, minGap).length >= MAX_SECTIONS) {
    return false;
  }
  const boundaries = [0, ...sanitizeSplitTimes(sourceDuration, splitTimes, minGap), sourceDuration];
  return boundaries.every((b) => Math.abs(b - t) >= minGap);
}

/**
 * Insert a split at time `t`, keeping the list sorted and valid. Returns the
 * original list unchanged when the split would be too close to a neighbour.
 */
export function insertSplit(
  splitTimes: number[],
  t: number,
  sourceDuration: number,
  minGap: number = MIN_SECTION_DURATION
): number[] {
  const current = sanitizeSplitTimes(sourceDuration, splitTimes, minGap);
  if (!canInsertSplit(current, t, sourceDuration, minGap)) {
    return current;
  }
  return [...current, t].sort((a, b) => a - b);
}

/**
 * Remove the split at `index` (position within the sorted interior splits).
 */
export function removeSplit(
  splitTimes: number[],
  index: number,
  sourceDuration: number,
  minGap: number = MIN_SECTION_DURATION
): number[] {
  const current = sanitizeSplitTimes(sourceDuration, splitTimes, minGap);
  if (index < 0 || index >= current.length) {
    return current;
  }
  return current.filter((_, i) => i !== index);
}

/**
 * Move the split at `index` to a new time, clamped so it stays strictly
 * between its neighbours (keeping every section at least `minGap` long). The
 * result stays sorted; the moved split keeps its ordinal position.
 */
export function moveSplit(
  splitTimes: number[],
  index: number,
  t: number,
  sourceDuration: number,
  minGap: number = MIN_SECTION_DURATION
): number[] {
  const current = sanitizeSplitTimes(sourceDuration, splitTimes, minGap);
  if (index < 0 || index >= current.length || !Number.isFinite(t)) {
    return current;
  }
  const lowerNeighbour = index > 0 ? current[index - 1] : 0;
  const upperNeighbour = index < current.length - 1 ? current[index + 1] : sourceDuration;
  const lowerBound = lowerNeighbour + minGap;
  const upperBound = upperNeighbour - minGap;
  if (lowerBound > upperBound) {
    // No room to move (neighbours too tight); leave it where it is.
    return current;
  }
  const next = [...current];
  next[index] = clamp(t, lowerBound, upperBound);
  return next;
}

/** Everything needed to describe the shared source of a split operation. */
export interface SplitSource {
  file: File | Blob;
  name: string;
  width?: number;
  height?: number;
  rotation?: Rotation;
  encodeCapability?: VideoEncodeCapability;
}

/** Per-section defaults applied when sections are first created. */
export interface SectionDefaults {
  outputDuration?: number;
  easingPreset?: string;
}

/**
 * Build the TransitionVideo segments for a set of sections. Each section
 * shares the source `file` but carries its own [sourceStartTime, sourceEndTime]
 * range and a fresh object URL (so the existing per-segment URL lifecycle in
 * page.tsx — create on build, revoke on cleanup — keeps working unchanged).
 *
 * `createObjectURL` is injected so this stays unit-testable without a DOM.
 */
export function buildSectionSegments(
  source: SplitSource,
  sections: Section[],
  defaults: SectionDefaults,
  createObjectURL: (file: File | Blob) => string
): TransitionVideo[] {
  const outputDuration = isFinitePositive(defaults.outputDuration ?? NaN)
    ? (defaults.outputDuration as number)
    : DEFAULT_OUTPUT_DURATION;
  const easingPreset = defaults.easingPreset ?? DEFAULT_EASING;

  return sections.map((section, i) => ({
    id: i + 1,
    name: `Section ${i + 1}`,
    url: createObjectURL(source.file),
    loading: false,
    duration: outputDuration,
    easingPreset,
    useCustomEasing: false,
    customBezier: getPresetBezier(easingPreset),
    loopIteration: 1,
    file: source.file,
    width: source.width,
    height: source.height,
    rotation: source.rotation,
    encodeCapability: source.encodeCapability,
    sourceStartTime: section.start,
    sourceEndTime: section.end,
  }));
}
