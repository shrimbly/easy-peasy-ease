import { describe, expect, it } from 'vitest';

import {
  AVC_LEVELS,
  MAX_BITS_PER_PIXEL,
  MIN_BITS_PER_PIXEL,
  PREVIEW_TIER_BITRATE,
  buildAvcCodecString,
  buildEncodeTiers,
  computeTargetBitrate,
  frameSizeInMacroblocks,
  pickAvcLevel,
  scaleToFit,
  type AvcProfile,
  type EncodeTier,
} from '@/lib/encode-planner';

/** Extract the levelIdc back out of an RFC 6381 avc1 codec string. */
const levelFromCodecString = (codec: string): number => parseInt(codec.slice(-2), 16);

/** Effective bitrate cap for a level and profile (high gets 1.25x). */
const levelCap = (maxBitrate: number, profile: AvcProfile): number =>
  profile === 'high' ? maxBitrate * 1.25 : maxBitrate;

describe('frameSizeInMacroblocks', () => {
  it('computes 1080p as 120x68 macroblocks (height rounds up)', () => {
    expect(frameSizeInMacroblocks(1920, 1080)).toBe(120 * 68);
  });

  it('rounds each dimension up independently', () => {
    expect(frameSizeInMacroblocks(17, 17)).toBe(2 * 2);
  });
});

describe('pickAvcLevel', () => {
  it('places 1080p30 at a modest bitrate in the 4.0-4.1 range', () => {
    const level = pickAvcLevel(1920, 1080, 30, 8_000_000, 'high');
    expect(level).not.toBeNull();
    expect(level!.levelIdc).toBeGreaterThanOrEqual(40);
    expect(level!.levelIdc).toBeLessThanOrEqual(41);
    // 8160 MBs at 30fps = 244,800 MB/s fits level 4.0 exactly
    expect(level!.levelIdc).toBe(40);
  });

  it('requires at least level 4.2 for 1080p60', () => {
    const level = pickAvcLevel(1920, 1080, 60, 8_000_000, 'high');
    expect(level).not.toBeNull();
    expect(level!.levelIdc).toBeGreaterThanOrEqual(42);
    expect(level!.levelIdc).toBe(42);
  });

  it('places 4K30 at level 5.1', () => {
    const level = pickAvcLevel(3840, 2160, 30, 40_000_000, 'high');
    expect(level?.levelIdc).toBe(51);
  });

  it('places 4K60 at level 5.2', () => {
    const level = pickAvcLevel(3840, 2160, 60, 40_000_000, 'high');
    expect(level?.levelIdc).toBe(52);
  });

  it('returns null for absurd dimensions beyond level 5.2', () => {
    expect(pickAvcLevel(16000, 16000, 30, 10_000_000, 'high')).toBeNull();
    expect(pickAvcLevel(16000, 16000, 1, 1, 'baseline')).toBeNull();
  });

  it('pushes the level up when bitrate exceeds the level cap (main profile)', () => {
    // 1080p30 fits level 4.0 spatially, but 4.0 caps at 20 Mbps for Main
    const level = pickAvcLevel(1920, 1080, 30, 45_000_000, 'main');
    expect(level?.levelIdc).toBe(41);
  });

  it('pushes the level up when bitrate exceeds the 1.25x high-profile cap', () => {
    // 45 Mbps > 25 Mbps (20 x 1.25), so high profile also lands on 4.1
    const level = pickAvcLevel(1920, 1080, 30, 45_000_000, 'high');
    expect(level?.levelIdc).toBe(41);
  });

  it('grants high profile 1.25x bitrate headroom over main at the same params', () => {
    // 24 Mbps: within 25 Mbps high cap for 4.0, above the 20 Mbps main cap
    expect(pickAvcLevel(1920, 1080, 30, 24_000_000, 'high')?.levelIdc).toBe(40);
    expect(pickAvcLevel(1920, 1080, 30, 24_000_000, 'main')?.levelIdc).toBe(41);
  });

  it('treats the high-profile cap boundary as inclusive', () => {
    expect(pickAvcLevel(1920, 1080, 30, 25_000_000, 'high')?.levelIdc).toBe(40);
    expect(pickAvcLevel(1920, 1080, 30, 25_000_001, 'high')?.levelIdc).toBe(41);
  });

  it('defaults to high profile when none is given', () => {
    expect(pickAvcLevel(1920, 1080, 30, 24_000_000)?.levelIdc).toBe(40);
  });
});

describe('buildAvcCodecString', () => {
  it("encodes high@4.2 as 'avc1.64002a'", () => {
    expect(buildAvcCodecString('high', 42)).toBe('avc1.64002a');
  });

  it("encodes baseline@3.1 as 'avc1.42001f'", () => {
    expect(buildAvcCodecString('baseline', 31)).toBe('avc1.42001f');
  });

  it("encodes main@4.0 as 'avc1.4d0028'", () => {
    expect(buildAvcCodecString('main', 40)).toBe('avc1.4d0028');
  });

  it('zero-pads single-hex-digit levels', () => {
    expect(buildAvcCodecString('high', 10)).toBe('avc1.64000a');
  });
});

describe('computeTargetBitrate', () => {
  const pixelRate1080p30 = 1920 * 1080 * 30;
  const floor1080p30 = Math.round(pixelRate1080p30 * MIN_BITS_PER_PIXEL);
  const ceiling1080p30 = Math.round(pixelRate1080p30 * MAX_BITS_PER_PIXEL);

  it('applies the MIN_BITS_PER_PIXEL floor when source bitrate is undefined', () => {
    expect(computeTargetBitrate(1920, 1080, 30, undefined, 'high')).toBe(floor1080p30);
  });

  it('applies the floor when source bitrate is tiny', () => {
    expect(computeTargetBitrate(1920, 1080, 30, 100_000, 'high')).toBe(floor1080p30);
  });

  it('applies the floor when source bitrate is zero, negative, NaN or Infinity', () => {
    // Non-finite sources fail the Number.isFinite guard and count as missing
    expect(computeTargetBitrate(1920, 1080, 30, 0, 'high')).toBe(floor1080p30);
    expect(computeTargetBitrate(1920, 1080, 30, -5_000_000, 'high')).toBe(floor1080p30);
    expect(computeTargetBitrate(1920, 1080, 30, Number.NaN, 'high')).toBe(floor1080p30);
    expect(computeTargetBitrate(1920, 1080, 30, Number.POSITIVE_INFINITY, 'high')).toBe(
      floor1080p30
    );
  });

  it('applies the MAX_BITS_PER_PIXEL ceiling when source bitrate is enormous', () => {
    expect(computeTargetBitrate(1920, 1080, 30, 1_000_000_000, 'high')).toBe(ceiling1080p30);
  });

  it('preserves the source bitrate when it lies between floor and ceiling', () => {
    const source = 10_000_000;
    expect(source).toBeGreaterThan(floor1080p30);
    expect(source).toBeLessThan(ceiling1080p30);
    expect(computeTargetBitrate(1920, 1080, 30, source, 'high')).toBe(source);
  });

  it('returns at least 1 for degenerate zero-pixel inputs', () => {
    expect(computeTargetBitrate(0, 0, 30, undefined, 'high')).toBe(1);
    expect(computeTargetBitrate(0, 1080, 60, 5_000_000, 'main')).toBe(1);
  });

  it('always returns a positive integer, even for fractional frame rates', () => {
    const cases: Array<[number, number, number, number | undefined, AvcProfile]> = [
      [1920, 1080, 29.97, 7_654_321.5, 'high'],
      [1280, 720, 23.976, undefined, 'main'],
      [640, 360, 59.94, 123.456, 'baseline'],
      [3840, 2160, 60, 500_000_000, 'high'],
    ];
    for (const [w, h, fps, src, profile] of cases) {
      const target = computeTargetBitrate(w, h, fps, src, profile);
      expect(Number.isInteger(target)).toBe(true);
      expect(target).toBeGreaterThanOrEqual(1);
    }
  });

  it('never exceeds the chosen level max bitrate for the profile', () => {
    const dims: Array<[number, number, number]> = [
      [1920, 1080, 30],
      [1920, 1080, 60],
      [3840, 2160, 30],
      [3840, 2160, 60],
      [1280, 720, 30],
      [640, 360, 60],
    ];
    const profiles: AvcProfile[] = ['high', 'main', 'baseline'];
    for (const [w, h, fps] of dims) {
      for (const profile of profiles) {
        for (const src of [undefined, 1_000, 20_000_000, 5_000_000_000]) {
          const target = computeTargetBitrate(w, h, fps, src, profile);
          const level = pickAvcLevel(w, h, fps, target, profile);
          expect(level).not.toBeNull();
          expect(target).toBeLessThanOrEqual(levelCap(level!.maxBitrate, profile));
        }
      }
    }
  });

  it('never exceeds the global maximum level cap even for huge sources', () => {
    const maxCap = levelCap(AVC_LEVELS[AVC_LEVELS.length - 1].maxBitrate, 'high');
    expect(computeTargetBitrate(3840, 2160, 60, Number.MAX_SAFE_INTEGER, 'high')).toBeLessThanOrEqual(
      maxCap
    );
  });
});

describe('scaleToFit', () => {
  it('never upscales a source smaller than the box', () => {
    expect(scaleToFit(640, 360, 1920, 1920)).toEqual({ width: 640, height: 360 });
    expect(scaleToFit(2, 2, 4096, 4096)).toEqual({ width: 2, height: 2 });
  });

  it('downscales 1080p landscape into a 1280 box preserving aspect exactly', () => {
    expect(scaleToFit(1920, 1080, 1280, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it('handles portrait symmetrically to landscape', () => {
    expect(scaleToFit(1080, 1920, 1280, 1280)).toEqual({ width: 720, height: 1280 });
    const landscape = scaleToFit(1920, 1080, 960, 960);
    const portrait = scaleToFit(1080, 1920, 960, 960);
    expect(portrait.width).toBe(landscape.height);
    expect(portrait.height).toBe(landscape.width);
  });

  it('leaves a portrait 1080x1920 source untouched inside a 1920x1920 box', () => {
    expect(scaleToFit(1080, 1920, 1920, 1920)).toEqual({ width: 1080, height: 1920 });
  });

  it('preserves aspect ratio within rounding for awkward sizes', () => {
    const cases: Array<[number, number, number, number]> = [
      [1000, 333, 500, 500],
      [4096, 2160, 1920, 1920],
      [1234, 567, 640, 640],
      [777, 1111, 960, 960],
    ];
    for (const [sw, sh, mw, mh] of cases) {
      const { width, height } = scaleToFit(sw, sh, mw, mh);
      const sourceRatio = sw / sh;
      const outRatio = width / height;
      // Even-flooring can shift each dimension by up to 2px
      const tolerance = sourceRatio * Math.max(2 / width, 2 / height) * 2 + 0.01;
      expect(Math.abs(outRatio - sourceRatio)).toBeLessThanOrEqual(tolerance);
      expect(width).toBeLessThanOrEqual(mw);
      expect(height).toBeLessThanOrEqual(mh);
    }
  });

  it('always returns even dimensions', () => {
    const cases: Array<[number, number, number, number]> = [
      [1919, 1079, 4096, 4096],
      [1000, 333, 500, 500],
      [641, 361, 1920, 1920],
      [1921, 1081, 1280, 1280],
    ];
    for (const [sw, sh, mw, mh] of cases) {
      const { width, height } = scaleToFit(sw, sh, mw, mh);
      expect(width % 2).toBe(0);
      expect(height % 2).toBe(0);
    }
  });

  it('floors odd source dimensions down to even without scaling', () => {
    expect(scaleToFit(1919, 1079, 4096, 4096)).toEqual({ width: 1918, height: 1078 });
  });

  it('clamps degenerate zero/negative inputs to at least 2x2 even dims', () => {
    for (const [sw, sh] of [
      [0, 0],
      [-100, 500],
      [500, -100],
      [0, 1080],
      [-1, -1],
    ]) {
      const { width, height } = scaleToFit(sw, sh, 1920, 1920);
      expect(width).toBeGreaterThanOrEqual(2);
      expect(height).toBeGreaterThanOrEqual(2);
      expect(width % 2).toBe(0);
      expect(height % 2).toBe(0);
    }
  });
});

describe('buildEncodeTiers', () => {
  const noDuplicateKeys = (tiers: EncodeTier[]) => {
    const keys = tiers.map((t) => `${t.width}x${t.height}@${t.frameRate}:${t.profile}`);
    expect(new Set(keys).size).toBe(keys.length);
  };

  describe('full quality', () => {
    const source = { width: 3840, height: 2160, bitrate: 50_000_000 };
    const tiers = buildEncodeTiers(source, 'full', [60, 30]);

    it('starts with a native-resolution 60fps tier that needs no resize', () => {
      expect(tiers.length).toBeGreaterThan(0);
      const first = tiers[0];
      expect(first.width).toBe(3840);
      expect(first.height).toBe(2160);
      expect(first.frameRate).toBe(60);
      expect(first.needsResize).toBe(false);
    });

    it('gives the native 4K tier a level >= 5.1 codec string', () => {
      const native = tiers.filter((t) => t.width === 3840 && t.height === 2160);
      expect(native.length).toBeGreaterThan(0);
      for (const tier of native) {
        expect(levelFromCodecString(tier.codecString)).toBeGreaterThanOrEqual(51);
      }
      // 4K60 specifically requires level 5.2
      const native60 = native.find((t) => t.frameRate === 60);
      expect(native60?.codecString).toBe('avc1.640034');
    });

    it('includes 1080p and 720p boxes with 30fps variants', () => {
      const has = (w: number, h: number, fps: number) =>
        tiers.some((t) => t.width === w && t.height === h && t.frameRate === fps);
      expect(has(1920, 1080, 60)).toBe(true);
      expect(has(1920, 1080, 30)).toBe(true);
      expect(has(1280, 720, 60)).toBe(true);
      expect(has(1280, 720, 30)).toBe(true);
      expect(has(3840, 2160, 30)).toBe(true);
    });

    it('marks downscaled tiers as needing resize', () => {
      for (const tier of tiers) {
        const isNative = tier.width === 3840 && tier.height === 2160;
        expect(tier.needsResize).toBe(!isNative);
      }
    });

    it('prefers high profile but degrades to main and baseline fallbacks', () => {
      // The best tier is High profile...
      expect(tiers[0].profile).toBe('high');
      expect(tiers[0].codecString.startsWith('avc1.6400')).toBe(true);
      // ...and every resolution/fps also offers Main and Baseline fallbacks so
      // encoders without High-profile support (e.g. Firefox openh264) still work.
      const native = tiers.filter((t) => t.width === 3840 && t.height === 2160 && t.frameRate === 60);
      expect(native.map((t) => t.profile)).toEqual(['high', 'main', 'baseline']);
      expect(native.find((t) => t.profile === 'baseline')?.codecString.startsWith('avc1.4200')).toBe(true);
      expect(native.find((t) => t.profile === 'main')?.codecString.startsWith('avc1.4d00')).toBe(true);
    });

    it('orders profiles high before main before baseline within a resolution/fps', () => {
      const rank = { high: 0, main: 1, baseline: 2 } as const;
      const groups = new Map<string, number[]>();
      for (const tier of tiers) {
        const key = `${tier.width}x${tier.height}@${tier.frameRate}`;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(rank[tier.profile]);
      }
      for (const ranks of groups.values()) {
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      }
    });

    it('contains no duplicate width x height @ fps entries', () => {
      noDuplicateKeys(tiers);
    });

    it('deduplicates when the source already matches a ladder box', () => {
      const hd = buildEncodeTiers({ width: 1920, height: 1080, bitrate: 12_000_000 }, 'full', [
        60, 30,
      ]);
      noDuplicateKeys(hd);
      // Original box and 1080p box both resolve to 1920x1080; only one set of
      // (2 frame rates x 3 profiles) survives for that resolution.
      expect(hd).toHaveLength(12);
      expect(hd[0].label).toBe('Original 60fps high');
      expect(hd.filter((t) => t.width === 1920 && t.height === 1080)).toHaveLength(6);
      expect(hd.filter((t) => t.width === 1280 && t.height === 720)).toHaveLength(6);
    });

    it('keeps tier bitrates level-conformant', () => {
      for (const tier of tiers) {
        const level = pickAvcLevel(tier.width, tier.height, tier.frameRate, tier.bitrate, tier.profile);
        expect(level).not.toBeNull();
        expect(tier.bitrate).toBeLessThanOrEqual(levelCap(level!.maxBitrate, tier.profile));
        expect(tier.codecString).toBe(buildAvcCodecString(tier.profile, level!.levelIdc));
      }
    });

    it('skips tiers whose dimensions exceed every AVC level', () => {
      const huge = buildEncodeTiers({ width: 16000, height: 16000 }, 'full', [60, 30]);
      // The Original box cannot be encoded at all; the ladder still offers downscales
      expect(huge.some((t) => t.width === 16000)).toBe(false);
      expect(huge.length).toBeGreaterThan(0);
      expect(huge.some((t) => t.label.startsWith('1080p'))).toBe(true);
    });
  });

  describe('preview quality', () => {
    const source = { width: 3840, height: 2160, bitrate: 50_000_000 };
    const tiers = buildEncodeTiers(source, 'preview', [30]);

    it('uses the baseline profile for every tier', () => {
      expect(tiers.length).toBeGreaterThan(0);
      for (const tier of tiers) {
        expect(tier.profile).toBe('baseline');
        expect(tier.codecString.startsWith('avc1.4200')).toBe(true);
      }
    });

    it('caps every tier bitrate at PREVIEW_TIER_BITRATE', () => {
      for (const tier of tiers) {
        expect(tier.bitrate).toBeLessThanOrEqual(PREVIEW_TIER_BITRATE);
      }
    });

    it('offers the 720p/540p/360p preview boxes', () => {
      const dims = tiers.map((t) => `${t.width}x${t.height}`);
      expect(dims).toEqual(['1280x720', '960x540', '640x360']);
    });

    it('never offers native resolution and always flags resize for a 4K source', () => {
      for (const tier of tiers) {
        expect(tier.width).toBeLessThanOrEqual(1280);
        expect(tier.needsResize).toBe(true);
      }
    });

    it('does not resize a source already smaller than the preview box', () => {
      const small = buildEncodeTiers({ width: 640, height: 360, bitrate: 1_000_000 }, 'preview', [30]);
      expect(small).toHaveLength(1);
      expect(small[0].width).toBe(640);
      expect(small[0].height).toBe(360);
      expect(small[0].needsResize).toBe(false);
    });

    it('contains no duplicate width x height @ fps entries', () => {
      noDuplicateKeys(tiers);
    });
  });

  describe('portrait sources', () => {
    const source = { width: 1080, height: 1920, bitrate: 16_000_000 };
    const tiers = buildEncodeTiers(source, 'full', [60, 30]);

    it('keeps 1080x1920 untouched since it fits the 1920x1920 box', () => {
      const native = tiers.filter((t) => t.width === 1080 && t.height === 1920);
      expect(native).toHaveLength(6); // 2 frame rates x 3 profiles
      for (const tier of native) {
        expect(tier.needsResize).toBe(false);
      }
      expect(tiers[0].width).toBe(1080);
      expect(tiers[0].height).toBe(1920);
      expect(tiers[0].frameRate).toBe(60);
      expect(tiers[0].profile).toBe('high');
    });

    it('dedupes the 1080p box against the untouched original', () => {
      noDuplicateKeys(tiers);
      // Original + 1080p box collapse into one set; 720p box adds 720x1280.
      // (2 frame rates x 3 profiles) x 2 resolutions = 12
      expect(tiers).toHaveLength(12);
      expect(tiers.some((t) => t.label.startsWith('1080p'))).toBe(false);
    });

    it('scales the portrait source into the 720p square box as 720x1280', () => {
      const downs = tiers.filter((t) => t.width === 720 && t.height === 1280);
      expect(downs).toHaveLength(6); // 2 frame rates x 3 profiles
      for (const tier of downs) {
        expect(tier.needsResize).toBe(true);
      }
    });

    it('mirrors the landscape ladder dimensions', () => {
      const landscape = buildEncodeTiers(
        { width: 1920, height: 1080, bitrate: 16_000_000 },
        'full',
        [60, 30]
      );
      expect(tiers.map((t) => `${t.height}x${t.width}@${t.frameRate}`)).toEqual(
        landscape.map((t) => `${t.width}x${t.height}@${t.frameRate}`)
      );
    });
  });

  describe('tier ordering and labels', () => {
    it('orders tiers highest fidelity first (resolution, then fps)', () => {
      const tiers = buildEncodeTiers({ width: 3840, height: 2160 }, 'full', [60, 30]);
      const areas = tiers.map((t) => t.width * t.height);
      for (let i = 1; i < areas.length; i++) {
        expect(areas[i]).toBeLessThanOrEqual(areas[i - 1]);
      }
      const native = tiers.filter((t) => t.width === 3840);
      // 60fps group (3 profiles) precedes the 30fps group (3 profiles)
      expect(native.map((t) => t.frameRate)).toEqual([60, 60, 60, 30, 30, 30]);
    });

    it('labels tiers with box name, frame rate, and profile', () => {
      const tiers = buildEncodeTiers({ width: 3840, height: 2160 }, 'full', [60, 30]);
      // Spot-check the first resolution/fps group degrades across profiles
      expect(tiers.slice(0, 3).map((t) => t.label)).toEqual([
        'Original 60fps high',
        'Original 60fps main',
        'Original 60fps baseline',
      ]);
      // Every label carries its profile suffix
      for (const tier of tiers) {
        expect(tier.label.endsWith(tier.profile)).toBe(true);
      }
    });
  });
});
