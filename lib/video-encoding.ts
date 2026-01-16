import type { VideoEncodingConfig } from 'mediabunny';
import { DEFAULT_KEYFRAME_INTERVAL, MAX_OUTPUT_FPS } from './speed-curve-config';

// Baseline profile, level 4.0 - legacy fallback only
export const AVC_BASELINE_4_0 = 'avc1.42C028';
// Main profile, level 4.0 - better compression with B-frames
export const AVC_MAIN_4_0 = 'avc1.4D4028';
// High profile, level 4.0 - best compression for 1080p
export const AVC_HIGH_4_0 = 'avc1.640028';
// High profile, level 5.1 for 4K support
export const AVC_HIGH_5_1 = 'avc1.640033';

// Aliases for backwards compatibility
export const AVC_LEVEL_4_0 = AVC_HIGH_4_0; // Use High profile by default for quality
export const AVC_LEVEL_5_1 = AVC_HIGH_5_1;

/**
 * Builds a stable AVC encoding config that works across Firefox/WebKit decoders.
 * Forces the encoder to emit AVC configuration records and keeps bitrate/keyframe
 * defaults in one place.
 */
export const createAvcEncodingConfig = (
  bitrate: number,
  width?: number,
  height?: number,
  codecString: string = AVC_LEVEL_4_0,
  framerate?: number
): VideoEncodingConfig => ({
  codec: 'avc',
  // Use 'contain' to resize/pad frames to match the target resolution, avoiding "sample size must remain constant" errors
  sizeChangeBehavior: 'contain',
  bitrate,
  keyFrameInterval: DEFAULT_KEYFRAME_INTERVAL,
  bitrateMode: 'variable',
  latencyMode: 'quality',
  fullCodecString: codecString,
  onEncoderConfig: (config) => {
    config.avc = { ...(config.avc ?? {}), format: 'avc' };
    if (!config.latencyMode) {
      config.latencyMode = 'quality';
    }
    if (framerate && framerate > 0) {
      config.framerate = framerate;
    } else if (!config.framerate) {
      config.framerate = MAX_OUTPUT_FPS;
    }
    config.bitrate = bitrate;
    if (width) config.width = width;
    if (height) config.height = height;
  },
});
