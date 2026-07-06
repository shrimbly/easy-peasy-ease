import type { VideoEncodingConfig } from 'mediabunny';
import { canEncodeVideo } from 'mediabunny';
import { DEFAULT_KEYFRAME_INTERVAL } from './speed-curve-config';
import type { EncodeTier } from './encode-planner';

/**
 * Shared encoder options applied to every tier. `hardwareAcceleration` is
 * deliberately left at 'no-preference' (mediabunny's recommendation): it lets
 * the browser pick hardware when available and silently fall back to software
 * when not, instead of failing on machines without a hardware H.264 encoder.
 */
const COMMON_OPTIONS = {
  keyFrameInterval: DEFAULT_KEYFRAME_INTERVAL,
  bitrateMode: 'variable',
  latencyMode: 'quality',
  hardwareAcceleration: 'no-preference',
} as const;

/**
 * Build the mediabunny encoding config for a planned tier. When the tier's
 * dimensions differ from the source frames, mediabunny resizes each sample
 * on a canvas before encoding (`transform`), so the encoder genuinely
 * receives tier-sized frames — downscale fallbacks work on every browser
 * rather than relying on encoder-side scaling.
 */
export const createTierEncodingConfig = (tier: EncodeTier): VideoEncodingConfig => ({
  codec: 'avc',
  bitrate: tier.bitrate,
  fullCodecString: tier.codecString,
  ...COMMON_OPTIONS,
  ...(tier.needsResize
    ? {
        // sizeChangeBehavior must allow varying raw sample sizes: mediabunny
        // checks size constancy on the RAW sample before the transform
        // normalizes it, so mixed-size inputs throw under the default 'deny'.
        sizeChangeBehavior: 'passThrough' as const,
        transform: { width: tier.width, height: tier.height, fit: 'contain' as const },
      }
    : {}),
  onEncoderConfig: (config) => {
    config.avc = { ...(config.avc ?? {}), format: 'avc' };
    if (tier.frameRate > 0) {
      config.framerate = tier.frameRate;
    }
  },
});

/**
 * Probe whether this machine can encode a tier, using the SAME options the
 * real encoder will be configured with. Probe/encode parity matters: probing
 * a laxer config than the one used to encode is how "supported" machines
 * fail minutes into a render.
 */
export const canEncodeTier = (tier: EncodeTier): Promise<boolean> =>
  canEncodeVideo('avc', {
    width: tier.width,
    height: tier.height,
    bitrate: tier.bitrate,
    fullCodecString: tier.codecString,
    ...COMMON_OPTIONS,
  });

/**
 * Return the first tier of the ladder this machine can actually encode, or
 * null when none fit (caller should surface a clear error before starting).
 */
export async function selectSupportedTier(tiers: EncodeTier[]): Promise<EncodeTier | null> {
  for (const tier of tiers) {
    if (await canEncodeTier(tier)) {
      return tier;
    }
  }
  return null;
}
