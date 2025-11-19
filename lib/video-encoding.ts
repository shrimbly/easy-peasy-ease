import type { VideoEncodingConfig } from 'mediabunny';
import { DEFAULT_KEYFRAME_INTERVAL, MAX_OUTPUT_FPS } from './speed-curve-config';

// Baseline profile, level 4.0 keeps reference frames minimal for Firefox forks
export const AVC_LEVEL_4_0 = 'avc1.42C028';
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
  codecString: string = AVC_LEVEL_4_0
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
    if (!config.framerate) {
      config.framerate = MAX_OUTPUT_FPS;
    }
    config.bitrate = bitrate;
    if (width) config.width = width;
    if (height) config.height = height;
  },
});
