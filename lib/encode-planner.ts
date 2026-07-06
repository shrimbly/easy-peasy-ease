/**
 * Encode Planner
 *
 * Pure functions that plan H.264/AVC encoding parameters adaptively for the
 * machine and source material at hand. The planner produces an ordered ladder
 * of encode tiers (highest fidelity first); callers probe each tier with
 * mediabunny's `canEncodeVideo` using the EXACT options that will later be
 * used to encode, and use the first tier the device supports.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a browser encoder.
 */

import type { RenderQuality } from './types';

export type AvcProfile = 'high' | 'main' | 'baseline';

export interface AvcLevel {
  /** Level number ×10, e.g. 42 for level 4.2 */
  levelIdc: number;
  /** Max frame size in macroblocks (16x16) */
  maxFrameSizeMb: number;
  /** Max macroblock throughput per second */
  maxMbPerSec: number;
  /** Max video bitrate in bits/s for Baseline/Main (High profile allows ×1.25) */
  maxBitrate: number;
}

/**
 * AVC levels relevant to web video, ascending.
 * Values from ITU-T H.264 Table A-1 (MaxBR in 1000 bits/s for Baseline/Main).
 */
export const AVC_LEVELS: AvcLevel[] = [
  { levelIdc: 31, maxFrameSizeMb: 3_600, maxMbPerSec: 108_000, maxBitrate: 14_000_000 },
  { levelIdc: 32, maxFrameSizeMb: 5_120, maxMbPerSec: 216_000, maxBitrate: 20_000_000 },
  { levelIdc: 40, maxFrameSizeMb: 8_192, maxMbPerSec: 245_760, maxBitrate: 20_000_000 },
  { levelIdc: 41, maxFrameSizeMb: 8_192, maxMbPerSec: 245_760, maxBitrate: 50_000_000 },
  { levelIdc: 42, maxFrameSizeMb: 8_704, maxMbPerSec: 522_240, maxBitrate: 50_000_000 },
  { levelIdc: 50, maxFrameSizeMb: 22_080, maxMbPerSec: 589_824, maxBitrate: 135_000_000 },
  { levelIdc: 51, maxFrameSizeMb: 36_864, maxMbPerSec: 983_040, maxBitrate: 240_000_000 },
  { levelIdc: 52, maxFrameSizeMb: 36_864, maxMbPerSec: 2_073_600, maxBitrate: 240_000_000 },
];

const PROFILE_IDC: Record<AvcProfile, string> = {
  baseline: '42',
  main: '4d',
  high: '64',
};

/** High profile permits 1.25× the Baseline/Main MaxBR */
const HIGH_PROFILE_BITRATE_FACTOR = 1.25;

const macroblocks = (pixels: number) => Math.ceil(pixels / 16);

export const frameSizeInMacroblocks = (width: number, height: number): number =>
  macroblocks(width) * macroblocks(height);

/**
 * Pick the lowest AVC level that fits the given dimensions, frame rate and
 * bitrate. Returns null when nothing fits (dimensions beyond level 5.2).
 */
export function pickAvcLevel(
  width: number,
  height: number,
  frameRate: number,
  bitrate: number,
  profile: AvcProfile = 'high'
): AvcLevel | null {
  const frameMb = frameSizeInMacroblocks(width, height);
  const mbPerSec = frameMb * frameRate;
  const bitrateFactor = profile === 'high' ? HIGH_PROFILE_BITRATE_FACTOR : 1;

  for (const level of AVC_LEVELS) {
    if (
      frameMb <= level.maxFrameSizeMb &&
      mbPerSec <= level.maxMbPerSec &&
      bitrate <= level.maxBitrate * bitrateFactor
    ) {
      return level;
    }
  }
  return null;
}

/** Build an RFC 6381 AVC codec string, e.g. high@4.2 -> 'avc1.64002a' */
export function buildAvcCodecString(profile: AvcProfile, levelIdc: number): string {
  const levelHex = levelIdc.toString(16).padStart(2, '0');
  return `avc1.${PROFILE_IDC[profile]}00${levelHex}`;
}

/**
 * Bits-per-pixel-per-frame policy.
 *
 * The app's purpose is high-quality speed-ramped loops, so we preserve the
 * source bitrate wherever possible, bounded by:
 *  - a floor so quality never starves when source metadata is missing/low,
 *  - a ceiling beyond which H.264 gains nothing perceivable,
 *  - the AVC level's own max bitrate for the chosen profile.
 */
export const MIN_BITS_PER_PIXEL = 0.08;
export const MAX_BITS_PER_PIXEL = 0.25;

export function computeTargetBitrate(
  width: number,
  height: number,
  frameRate: number,
  sourceBitrate: number | undefined,
  profile: AvcProfile = 'high'
): number {
  const pixelRate = width * height * frameRate;
  const floor = Math.round(pixelRate * MIN_BITS_PER_PIXEL);
  const ceiling = Math.round(pixelRate * MAX_BITS_PER_PIXEL);

  const source =
    typeof sourceBitrate === 'number' && Number.isFinite(sourceBitrate) && sourceBitrate > 0
      ? sourceBitrate
      : 0;

  let target = Math.min(Math.max(source, floor), ceiling);

  // Respect the level cap for whatever level these parameters land in. Since
  // raising bitrate can bump the level (and its cap), resolve by checking the
  // level chosen for the capped bitrate.
  const level = pickAvcLevel(width, height, frameRate, target, profile);
  if (level) {
    const bitrateFactor = profile === 'high' ? HIGH_PROFILE_BITRATE_FACTOR : 1;
    target = Math.min(target, Math.floor(level.maxBitrate * bitrateFactor));
  }

  return Math.max(1, Math.round(target));
}

/**
 * Scale source dimensions to fit within a bounding box, preserving aspect
 * ratio, never upscaling, and always returning even dimensions (required by
 * 4:2:0 chroma subsampling).
 */
export function scaleToFit(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const safeW = Math.max(2, Math.floor(sourceWidth));
  const safeH = Math.max(2, Math.floor(sourceHeight));
  const scale = Math.min(maxWidth / safeW, maxHeight / safeH, 1);
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  return { width: even(safeW * scale), height: even(safeH * scale) };
}

export interface EncodeTier {
  /** Human-readable label used in progress messages */
  label: string;
  /** Encoder frame dimensions (post-resize, coded orientation) */
  width: number;
  height: number;
  /** Output frame rate */
  frameRate: number;
  /** Target bitrate in bits/s, level-conformant */
  bitrate: number;
  profile: AvcProfile;
  /** Full RFC 6381 codec string, level-correct for the tier */
  codecString: string;
  /** True when the tier requires downscaling source frames before encode */
  needsResize: boolean;
}

export interface SourceVideoInfo {
  /** Coded (pre-rotation) dimensions of the source */
  width: number;
  height: number;
  /** Average source bitrate in bits/s when known */
  bitrate?: number;
}

interface TierSpec {
  maxWidth: number;
  maxHeight: number;
  label: string;
}

const FULL_QUALITY_BOXES: TierSpec[] = [
  { maxWidth: Number.POSITIVE_INFINITY, maxHeight: Number.POSITIVE_INFINITY, label: 'Original' },
  { maxWidth: 1920, maxHeight: 1920, label: '1080p' },
  { maxWidth: 1280, maxHeight: 1280, label: '720p' },
];

const PREVIEW_BOXES: TierSpec[] = [
  { maxWidth: 1280, maxHeight: 1280, label: 'Preview 720p' },
  { maxWidth: 960, maxHeight: 960, label: 'Preview 540p' },
  { maxWidth: 640, maxHeight: 640, label: 'Preview 360p' },
];

export const PREVIEW_TIER_BITRATE = 4_000_000;
export const PREVIEW_TIER_FPS = 30;

/**
 * Build the ordered ladder of encode tiers for a source video. The first
 * entry is the best-quality plan; later entries progressively trade
 * resolution and frame rate for compatibility so weaker machines still
 * produce the best result they are capable of.
 *
 * Note the bounding boxes are square (e.g. 1920×1920) so portrait sources
 * are treated symmetrically to landscape ones.
 */
export function buildEncodeTiers(
  source: SourceVideoInfo,
  quality: RenderQuality,
  frameRates: number[]
): EncodeTier[] {
  const isPreview = quality === 'preview';
  const boxes = isPreview ? PREVIEW_BOXES : FULL_QUALITY_BOXES;
  const profile: AvcProfile = isPreview ? 'baseline' : 'high';

  const tiers: EncodeTier[] = [];
  const seen = new Set<string>();

  for (const box of boxes) {
    const { width, height } = scaleToFit(source.width, source.height, box.maxWidth, box.maxHeight);

    for (const frameRate of frameRates) {
      const key = `${width}x${height}@${frameRate}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const bitrate = isPreview
        ? Math.min(PREVIEW_TIER_BITRATE, computeTargetBitrate(width, height, frameRate, source.bitrate, profile))
        : computeTargetBitrate(width, height, frameRate, source.bitrate, profile);

      const level = pickAvcLevel(width, height, frameRate, bitrate, profile);
      if (!level) continue;

      tiers.push({
        label: `${box.label} ${frameRate}fps`,
        width,
        height,
        frameRate,
        bitrate,
        profile,
        codecString: buildAvcCodecString(profile, level.levelIdc),
        needsResize: width < Math.floor(source.width) || height < Math.floor(source.height),
      });
    }
  }

  return tiers;
}
