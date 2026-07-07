import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  warpTime,
  warpTimeCubic,
  warpTimeQuartic,
  warpTimeLinear,
  calculateWarpedDuration,
  validateWarpFunction,
  analyzeWarpCurve,
  selectAdaptiveEasing,
  buildEasedSourceTimestamps,
  type VideoCurveMetadata,
} from '@/lib/speed-curve';
import { easing, getAllEasingNames, type EasingFunction } from '@/lib/easing-functions';

const IN = 5;
const OUT = 1.5;

// Every easing shipped by the library is monotonic increasing on [0, 1].
const allEasingNames = getAllEasingNames();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warpTime', () => {
  describe('endpoints (string names)', () => {
    it.each([
      'linear',
      'easeInQuad',
      'easeOutQuad',
      'easeInOutCubic',
      'easeInExpo',
      'easeInOutQuint',
      'easeInExpoOutCubic',
    ])('%s maps 0 -> 0 and inputDuration -> outputDuration', (name) => {
      expect(warpTime(0, IN, OUT, name)).toBe(0);
      expect(warpTime(IN, IN, OUT, name)).toBe(OUT);
    });
  });

  describe('endpoints (function refs)', () => {
    it.each([
      ['easing.linear', easing.linear],
      ['easing.easeInOutCubic', easing.easeInOutCubic],
      ['easing.easeInQuartOutQuad', easing.easeInQuartOutQuad],
      ['custom quad', ((t: number) => t * t) as EasingFunction],
    ])('%s maps 0 -> 0 and inputDuration -> outputDuration', (_label, fn) => {
      expect(warpTime(0, IN, OUT, fn)).toBe(0);
      expect(warpTime(IN, IN, OUT, fn)).toBe(OUT);
    });

    it('respects non-default durations', () => {
      expect(warpTime(0, 10, 3, 'easeInOutSine')).toBe(0);
      expect(warpTime(10, 10, 3, 'easeInOutSine')).toBe(3);
    });

    it('uses defaults inputDuration=5, outputDuration=1.5, easeInOutCubic', () => {
      expect(warpTime(0)).toBe(0);
      expect(warpTime(5)).toBe(1.5);
      // easeInOutCubic is symmetric, so its inverse fixes the midpoint
      expect(warpTime(2.5)).toBeCloseTo(0.75, 6);
    });
  });

  describe('monotonicity', () => {
    it.each(allEasingNames)(
      '%s is monotonic non-decreasing over 200 samples',
      (name) => {
        const violations: string[] = [];
        let prev = warpTime(0, IN, OUT, name);
        for (let i = 1; i <= 200; i++) {
          const t = (i / 200) * IN;
          const w = warpTime(t, IN, OUT, name);
          if (w < prev) {
            violations.push(`t=${t}: ${w} < ${prev}`);
          }
          prev = w;
        }
        expect(violations).toEqual([]);
      }
    );

    it('stays within [0, outputDuration] across the whole input range', () => {
      for (const name of allEasingNames) {
        for (let i = 0; i <= 200; i++) {
          const w = warpTime((i / 200) * IN, IN, OUT, name);
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(OUT);
        }
      }
    });
  });

  describe('clamping of out-of-range input times', () => {
    it('clamps negative times to 0', () => {
      expect(warpTime(-1, IN, OUT, 'easeInOutCubic')).toBe(0);
      expect(warpTime(-0.0001, IN, OUT, 'linear')).toBe(0);
      expect(warpTime(-1e9, IN, OUT, 'easeInQuad')).toBe(0);
    });

    it('clamps times past inputDuration to outputDuration', () => {
      expect(warpTime(IN + 2, IN, OUT, 'easeInOutCubic')).toBe(OUT);
      expect(warpTime(IN + 1e-9, IN, OUT, 'linear')).toBe(OUT);
      expect(warpTime(1e9, IN, OUT, 'easeOutQuint')).toBe(OUT);
    });
  });

  describe('degenerate inputDuration guard', () => {
    it.each([0, -3, NaN, Infinity, -Infinity])(
      'returns 0 when inputDuration is %s',
      (dur) => {
        expect(warpTime(2.5, dur, OUT, 'easeInOutCubic')).toBe(0);
        expect(warpTime(0, dur, OUT, 'linear')).toBe(0);
        expect(warpTime(-1, dur, OUT, easing.easeInQuad)).toBe(0);
      }
    );

    it('never returns NaN for degenerate inputDuration', () => {
      expect(Number.isNaN(warpTime(1, 0, OUT))).toBe(false);
      expect(Number.isNaN(warpTime(1, NaN, OUT))).toBe(false);
    });
  });

  describe('inverse-easing semantics', () => {
    // mapTimeWithEasing applies the INVERSE of the easing, so an ease-in
    // curve allocates MORE output time to the start (slow start): the
    // warped position at mid-input lies ABOVE the linear mapping.
    it('easeInQuad at mid input maps above the linear mapping (slow start)', () => {
      const linearMid = warpTime(IN / 2, IN, OUT, 'linear');
      const easeInMid = warpTime(IN / 2, IN, OUT, 'easeInQuad');
      expect(linearMid).toBeCloseTo(0.75, 6);
      expect(easeInMid).toBeGreaterThan(linearMid);
      // inverse of t^2 is sqrt(t): sqrt(0.5) * 1.5
      expect(easeInMid).toBeCloseTo(Math.SQRT1_2 * OUT, 5);
    });

    it('easeOutQuad at mid input maps below the linear mapping (fast start)', () => {
      const easeOutMid = warpTime(IN / 2, IN, OUT, 'easeOutQuad');
      expect(easeOutMid).toBeLessThan(0.75);
      // inverse of t(2-t) at 0.5 is 1 - sqrt(0.5)
      expect(easeOutMid).toBeCloseTo((1 - Math.SQRT1_2) * OUT, 5);
    });

    it('symmetric easeInOutCubic fixes the midpoint at outputDuration/2', () => {
      expect(warpTime(IN / 2, IN, OUT, easing.easeInOutCubic)).toBeCloseTo(OUT / 2, 6);
    });

    it('easeInQuad consumes more output time than linear early on', () => {
      const earlyLinear = warpTime(0.5, IN, OUT, 'linear');
      const earlyEaseIn = warpTime(0.5, IN, OUT, 'easeInQuad');
      expect(earlyEaseIn).toBeGreaterThan(earlyLinear);
    });

    it('string name and function ref produce identical results', () => {
      expect(warpTime(1.7, IN, OUT, 'easeInOutCubic')).toBe(
        warpTime(1.7, IN, OUT, easing.easeInOutCubic)
      );
      expect(warpTime(3.9, IN, OUT, 'easeInExpoOutCubic')).toBe(
        warpTime(3.9, IN, OUT, easing.easeInExpoOutCubic)
      );
    });

    it('unknown easing name falls back to linear (with a warning)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(warpTime(2.5, IN, OUT, 'notARealEasing')).toBeCloseTo(0.75, 6);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('non-monotonic easing falls back to direct mapping and warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bump: EasingFunction = (t) => Math.sin(Math.PI * t);
      // Direct mapping: f(0.5) * OUT = 1 * 1.5
      expect(warpTime(IN / 2, IN, OUT, bump)).toBeCloseTo(OUT, 6);
      // f(1) = sin(pi) ~ 0, so the "end" collapses back to ~0
      expect(warpTime(IN, IN, OUT, bump)).toBeCloseTo(0, 6);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('deprecated wrappers', () => {
    it('warpTimeCubic matches warpTime with easeInOutCubic', () => {
      expect(warpTimeCubic(2.5, IN, OUT)).toBe(warpTime(2.5, IN, OUT, easing.easeInOutCubic));
      expect(warpTimeCubic(0)).toBe(0);
      expect(warpTimeCubic(5)).toBe(1.5);
    });

    it('warpTimeQuartic matches warpTime with easeInOutQuart', () => {
      expect(warpTimeQuartic(2.5, IN, OUT)).toBe(warpTime(2.5, IN, OUT, easing.easeInOutQuart));
      expect(warpTimeQuartic(0)).toBe(0);
      expect(warpTimeQuartic(5)).toBe(1.5);
    });

    it('warpTimeLinear is a pure linear remap', () => {
      expect(warpTimeLinear(0)).toBe(0);
      expect(warpTimeLinear(2.5)).toBeCloseTo(0.75, 6);
      expect(warpTimeLinear(5)).toBe(1.5);
    });
  });
});

describe('calculateWarpedDuration', () => {
  it.each(['linear', 'easeInQuad', 'easeInOutCubic', 'easeInExpoOutCubic'])(
    'sums to outputDuration across contiguous frames (%s)',
    (name) => {
      const frameCount = 50;
      const frameDur = IN / frameCount;
      let total = 0;
      for (let i = 0; i < frameCount; i++) {
        total += calculateWarpedDuration(i * frameDur, frameDur, IN, OUT, name);
      }
      expect(total).toBeCloseTo(OUT, 6);
    }
  );

  it('produces non-negative durations for every frame of every easing', () => {
    const frameCount = 100;
    const frameDur = IN / frameCount;
    for (const name of allEasingNames) {
      for (let i = 0; i < frameCount; i++) {
        const d = calculateWarpedDuration(i * frameDur, frameDur, IN, OUT, name);
        expect(d).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('ease-in gives the first frame more output time than the last frame', () => {
    const frameDur = 0.1;
    const first = calculateWarpedDuration(0, frameDur, IN, OUT, 'easeInQuad');
    const last = calculateWarpedDuration(IN - frameDur, frameDur, IN, OUT, 'easeInQuad');
    expect(first).toBeGreaterThan(last);
  });

  it('linear easing gives every frame the same scaled duration', () => {
    const frameDur = 0.1;
    const expected = frameDur * (OUT / IN);
    for (const start of [0, 1.2, 2.5, 4.9]) {
      expect(calculateWarpedDuration(start, frameDur, IN, OUT, 'linear')).toBeCloseTo(expected, 5);
    }
  });

  it('returns 0 for degenerate inputDuration', () => {
    expect(calculateWarpedDuration(0, 0.1, 0, OUT, 'linear')).toBe(0);
    expect(calculateWarpedDuration(1, 0.1, NaN, OUT, 'easeInOutCubic')).toBe(0);
  });
});

describe('validateWarpFunction', () => {
  it.each(['linear', 'easeInQuad', 'easeInOutCubic', 'easeInOutExpo', 'easeInExpoOutCubic'])(
    'reports valid for standard easing %s',
    (name) => {
      const result = validateWarpFunction(name, IN, OUT);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    }
  );

  it('reports valid for a function ref and for the defaults', () => {
    expect(validateWarpFunction(easing.easeInOutQuart, IN, OUT).valid).toBe(true);
    expect(validateWarpFunction().valid).toBe(true);
  });

  it('rejects inputDuration = 0 without hanging', { timeout: 1000 }, () => {
    const result = validateWarpFunction('easeInOutCubic', 0, OUT);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/inputDuration/);
  });

  it('rejects negative and non-finite inputDuration', { timeout: 1000 }, () => {
    for (const bad of [-5, NaN, Infinity]) {
      const result = validateWarpFunction('linear', bad, OUT);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/inputDuration/);
    }
  });

  it('rejects outputDuration = 0 without hanging', { timeout: 1000 }, () => {
    const result = validateWarpFunction('easeInOutCubic', IN, 0);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/outputDuration/);
  });

  it('rejects negative and non-finite outputDuration', { timeout: 1000 }, () => {
    for (const bad of [-1.5, NaN, -Infinity]) {
      const result = validateWarpFunction('linear', IN, bad);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/outputDuration/);
    }
  });

  it('flags a non-monotonic easing as invalid', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bump: EasingFunction = (t) => Math.sin(Math.PI * t);
    const result = validateWarpFunction(bump, IN, OUT);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('analyzeWarpCurve', () => {
  it('linear easing yields avgSpeed close to 1.0 (relative measure)', () => {
    const { avgSpeed, minSpeed, maxSpeed } = analyzeWarpCurve('linear', IN, OUT);
    expect(avgSpeed).toBeCloseTo(1.0, 3);
    expect(minSpeed).toBeCloseTo(1.0, 3);
    expect(maxSpeed).toBeCloseTo(1.0, 3);
  });

  it.each(['linear', 'easeInQuad', 'easeInOutCubic', 'easeInExpoOutCubic'])(
    'min <= avg <= max for %s',
    (name) => {
      const { minSpeed, avgSpeed, maxSpeed } = analyzeWarpCurve(name, IN, OUT);
      expect(minSpeed).toBeLessThanOrEqual(avgSpeed);
      expect(avgSpeed).toBeLessThanOrEqual(maxSpeed);
    }
  );

  it('all speed multipliers are finite and non-negative', () => {
    for (const name of ['linear', 'easeInOutCubic', 'easeInExpoOutCubic']) {
      const { speedMultipliers } = analyzeWarpCurve(name, IN, OUT);
      for (const m of speedMultipliers) {
        expect(Number.isFinite(m)).toBe(true);
        expect(m).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('easeInOutCubic spans below and above the linear baseline', () => {
    const { minSpeed, maxSpeed } = analyzeWarpCurve('easeInOutCubic', IN, OUT);
    expect(minSpeed).toBeLessThan(1);
    expect(maxSpeed).toBeGreaterThan(1);
  });

  it('returns one multiplier per sample (default 100, custom respected)', () => {
    expect(analyzeWarpCurve('linear', IN, OUT).speedMultipliers).toHaveLength(100);
    expect(analyzeWarpCurve('linear', IN, OUT, 25).speedMultipliers).toHaveLength(25);
  });
});

describe('selectAdaptiveEasing', () => {
  const meta = (duration: number, frameRate: number, bitrateMbps: number): VideoCurveMetadata => ({
    duration,
    frameRate,
    bitrate: bitrateMbps * 1_000_000,
  });

  it('short duration selects gentle easeInOutQuad', () => {
    const sel = selectAdaptiveEasing(meta(2, 30, 8));
    expect(sel.easingName).toBe('easeInOutQuad');
    expect(sel.profile).toBe('gentle');
    expect(sel.easingFunction).toBe(easing.easeInOutQuad);
  });

  it('low frame rate selects gentle easeInOutQuad', () => {
    const sel = selectAdaptiveEasing(meta(5, 15, 8));
    expect(sel.easingName).toBe('easeInOutQuad');
    expect(sel.profile).toBe('gentle');
  });

  it('low bitrate selects gentle easeInOutQuad', () => {
    const sel = selectAdaptiveEasing(meta(5, 30, 2));
    expect(sel.easingName).toBe('easeInOutQuad');
    expect(sel.profile).toBe('gentle');
  });

  it('mid-tier sources get balanced curves', () => {
    const low = selectAdaptiveEasing(meta(5, 25, 6));
    expect(low.easingName).toBe('easeInOutCubic');
    expect(low.profile).toBe('balanced');

    const mid = selectAdaptiveEasing(meta(5, 30, 6));
    expect(mid.easingName).toBe('easeInQuartOutQuad');
    expect(mid.profile).toBe('balanced');
  });

  it('high fps + high bitrate selects dynamic easeInExpoOutCubic', () => {
    const sel = selectAdaptiveEasing(meta(5, 60, 12));
    expect(sel.easingName).toBe('easeInExpoOutCubic');
    expect(sel.profile).toBe('dynamic');
    expect(sel.easingFunction).toBe(easing.easeInExpoOutCubic);
  });

  it('45fps / 8Mbps also lands on dynamic easeInExpoOutCubic', () => {
    const sel = selectAdaptiveEasing(meta(5, 45, 8));
    expect(sel.easingName).toBe('easeInExpoOutCubic');
    expect(sel.profile).toBe('dynamic');
  });

  it('duration >= 7 escalates a balanced profile to dynamic', () => {
    const sel = selectAdaptiveEasing(meta(8, 25, 4));
    expect(sel.easingName).toBe('easeInExpoOutCubic');
    expect(sel.profile).toBe('dynamic');
  });

  it('duration >= 7 does NOT escalate a gentle profile', () => {
    const sel = selectAdaptiveEasing(meta(9, 15, 8));
    expect(sel.easingName).toBe('easeInOutQuad');
    expect(sel.profile).toBe('gentle');
  });

  it('NaN metadata falls back to defaults without throwing (gentle)', () => {
    const sel = selectAdaptiveEasing(meta(NaN, NaN, NaN));
    // duration falls back to 1 (<= 2.4) and bitrate to 0, so gentle wins
    expect(sel.easingName).toBe('easeInOutQuad');
    expect(sel.profile).toBe('gentle');
    expect(sel.easingFunction).toBe(easing.easeInOutQuad);
  });

  it('negative metadata falls back to defaults without throwing', () => {
    const sel = selectAdaptiveEasing({ duration: -5, frameRate: -10, bitrate: -1 });
    expect(sel.easingName).toBe('easeInOutQuad');
    expect(sel.profile).toBe('gentle');
  });

  it('invalid bitrate forces gentle even with a good fps and duration', () => {
    const sel = selectAdaptiveEasing({ duration: 5, frameRate: 60, bitrate: NaN });
    expect(sel.profile).toBe('gentle');
  });

  it('always returns the function matching easingName', () => {
    const cases: VideoCurveMetadata[] = [
      meta(2, 30, 8),
      meta(5, 25, 6),
      meta(5, 30, 6),
      meta(5, 60, 12),
      meta(8, 25, 4),
      meta(NaN, NaN, NaN),
    ];
    for (const m of cases) {
      const sel = selectAdaptiveEasing(m);
      expect(sel.easingFunction).toBe(easing[sel.easingName]);
    }
  });
});

describe('buildEasedSourceTimestamps', () => {
  const linear: EasingFunction = (t) => t;

  it('emits exactly outputFrameCount samples', () => {
    const ts = buildEasedSourceTimestamps({
      spanStart: 0,
      spanEnd: 5,
      trackEnd: 5,
      easing: linear,
      outputFrameCount: 45,
      minFrameInterval: 1 / 30,
    });
    expect(ts).toHaveLength(45);
  });

  it('starts at spanStart and (with linear easing) rises monotonically', () => {
    const ts = buildEasedSourceTimestamps({
      spanStart: 2,
      spanEnd: 7,
      trackEnd: 10,
      easing: linear,
      outputFrameCount: 30,
      minFrameInterval: 1 / 30,
    });
    expect(ts[0]).toBeCloseTo(2, 6);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
    }
  });

  it('samples a sub-range instead of the whole track', () => {
    // A middle section [4, 6] of a 10s track must never sample outside it.
    const ts = buildEasedSourceTimestamps({
      spanStart: 4,
      spanEnd: 6,
      trackEnd: 10,
      easing: linear,
      outputFrameCount: 60,
      minFrameInterval: 1 / 60,
    });
    for (const t of ts) {
      expect(t).toBeGreaterThanOrEqual(4);
      expect(t).toBeLessThanOrEqual(6);
    }
    expect(ts[0]).toBeCloseTo(4, 6);
  });

  it('clamps the final sample inside the last frame of the section', () => {
    const minFrameInterval = 1 / 30;
    const ts = buildEasedSourceTimestamps({
      spanStart: 0,
      spanEnd: 5,
      trackEnd: 5,
      easing: linear,
      outputFrameCount: 30,
      minFrameInterval,
    });
    const last = ts[ts.length - 1];
    // Strictly less than spanEnd so a decode request can't fall off the track.
    expect(last).toBeLessThan(5);
    expect(last).toBeCloseTo(5 - Math.min(0.001, minFrameInterval / 2), 6);
  });

  it('never exceeds the track end even when spanEnd is beyond it', () => {
    const ts = buildEasedSourceTimestamps({
      spanStart: 0,
      spanEnd: 8,
      trackEnd: 5,
      easing: linear,
      outputFrameCount: 40,
      minFrameInterval: 1 / 30,
    });
    for (const t of ts) {
      expect(t).toBeLessThanOrEqual(5);
    }
  });

  it('handles a degenerate zero-length span without NaN', () => {
    const ts = buildEasedSourceTimestamps({
      spanStart: 3,
      spanEnd: 3,
      trackEnd: 10,
      easing: linear,
      outputFrameCount: 10,
      minFrameInterval: 1 / 30,
    });
    expect(ts).toHaveLength(10);
    for (const t of ts) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeCloseTo(3, 6);
    }
  });

  it('applies the easing curve (ease-in samples the start slowly)', () => {
    const easeIn: EasingFunction = (t) => t * t;
    const ts = buildEasedSourceTimestamps({
      spanStart: 0,
      spanEnd: 10,
      trackEnd: 10,
      easing: easeIn,
      outputFrameCount: 11,
      minFrameInterval: 1 / 10,
    });
    // Halfway through the output, an ease-in curve is only ~25% into the source.
    const midpoint = ts[5];
    expect(midpoint).toBeLessThan(5);
    expect(midpoint).toBeCloseTo(2.5, 1);
  });
});
