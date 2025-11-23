import type { VideoEncodingConfig } from 'mediabunny';
import { DEFAULT_KEYFRAME_INTERVAL, MAX_OUTPUT_FPS } from './speed-curve-config';

// Baseline profile, level 4.0 keeps reference frames minimal for Firefox forks
export const AVC_LEVEL_4_0 = 'avc1.42C028';
// Baseline profile, level 4.2 for higher resolutions (up to 60fps 1080p or 30fps 1440p)
export const AVC_LEVEL_4_2 = 'avc1.42C02A';
// High profile, level 5.1 for 4K support
export const AVC_LEVEL_5_1 = 'avc1.640033';

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
