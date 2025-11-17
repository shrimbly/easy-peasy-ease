import type { VideoEncodingConfig } from 'mediabunny';
import { DEFAULT_KEYFRAME_INTERVAL, MAX_OUTPUT_FPS } from './speed-curve-config';

// Baseline profile, level 4.0 keeps reference frames minimal for Firefox forks
const AVC_FULL_CODEC_STRING = 'avc1.42C028';

/**
 * Builds a stable AVC encoding config that works across Firefox/WebKit decoders.
 * Forces the encoder to emit AVC configuration records and keeps bitrate/keyframe
 * defaults in one place.
 */
export const createAvcEncodingConfig = (bitrate: number): VideoEncodingConfig => ({
  codec: 'avc',
  bitrate,
  keyFrameInterval: DEFAULT_KEYFRAME_INTERVAL,
  bitrateMode: 'variable',
  latencyMode: 'quality',
  fullCodecString: AVC_FULL_CODEC_STRING,
  onEncoderConfig: (config) => {
    config.avc = { ...(config.avc ?? {}), format: 'avc' };
    if (!config.latencyMode) {
      config.latencyMode = 'quality';
    }
    if (!config.framerate) {
      config.framerate = MAX_OUTPUT_FPS;
    }
    config.bitrate = bitrate;
  },
});
