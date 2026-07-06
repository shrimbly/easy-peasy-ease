import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  easing,
  createBezierEasing,
  getEasingFunction,
  getAllEasingNames,
  type EasingFunction,
} from '@/lib/easing-functions';

const easingEntries = Object.entries(easing) as [string, EasingFunction][];

const SAMPLES = 512;
const sampleTs = Array.from({ length: SAMPLES + 1 }, (_, i) => i / SAMPLES);

describe('easing record', () => {
  it('exports the expected number of easing functions (22 base + 2 hybrid)', () => {
    expect(easingEntries.length).toBe(24);
  });

  describe.each(easingEntries)('%s', (_name, fn) => {
    it('returns ~0 at t=0', () => {
      // Every implementation hits 0 exactly or within float noise
      // (easeInExpo/easeInOutExpo special-case t === 0).
      expect(Math.abs(fn(0))).toBeLessThanOrEqual(1e-9);
    });

    it('returns ~1 at t=1', () => {
      // easeInSine(1) = 1 - cos(PI/2) = 1 - 6.1e-17; everything else is exact.
      expect(Math.abs(fn(1) - 1)).toBeLessThanOrEqual(1e-9);
    });

    it('is finite for all t in [0,1]', () => {
      for (const t of sampleTs) {
        expect(Number.isFinite(fn(t))).toBe(true);
      }
    });

    it('is monotonic non-decreasing over 512 samples', () => {
      let prev = fn(0);
      for (let i = 1; i <= SAMPLES; i++) {
        const next = fn(i / SAMPLES);
        // tiny allowance for floating-point noise at branch boundaries
        expect(next).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = next;
      }
    });
  });

  it('easeInExpo jumps from exact 0 to 2^-10 scale just above t=0 (special-cased origin)', () => {
    expect(easing.easeInExpo(0)).toBe(0);
    expect(easing.easeInExpo(1e-9)).toBeCloseTo(Math.pow(2, -10), 6);
  });

  it('hybrid easings pass through 0.5 at t=0.5', () => {
    expect(easing.easeInExpoOutCubic(0.5)).toBeCloseTo(0.5, 12);
    expect(easing.easeInQuartOutQuad(0.5)).toBeCloseTo(0.5, 12);
  });

  it('easeInExpoOutCubic composes easeInExpo below 0.5 and easeOutCubic above', () => {
    expect(easing.easeInExpoOutCubic(0.25)).toBeCloseTo(0.5 * easing.easeInExpo(0.5), 12);
    expect(easing.easeInExpoOutCubic(0.75)).toBeCloseTo(0.5 + 0.5 * easing.easeOutCubic(0.5), 12);
  });

  it('easeInQuartOutQuad composes easeInQuart below 0.5 and easeOutQuad above', () => {
    expect(easing.easeInQuartOutQuad(0.25)).toBeCloseTo(0.5 * easing.easeInQuart(0.5), 12);
    expect(easing.easeInQuartOutQuad(0.75)).toBeCloseTo(0.5 + 0.5 * easing.easeOutQuad(0.5), 12);
  });
});

describe('createBezierEasing', () => {
  it('returns 0 at t=0 and 1 at t=1', () => {
    const fn = createBezierEasing(0.25, 0.1, 0.25, 1);
    expect(fn(0)).toBeCloseTo(0, 9);
    expect(fn(1)).toBeCloseTo(1, 9);
  });

  it('matches linear within 1e-4 for control points (0,0,1,1)', () => {
    const fn = createBezierEasing(0, 0, 1, 1);
    for (const t of sampleTs) {
      expect(Math.abs(fn(t) - t)).toBeLessThanOrEqual(1e-4);
    }
  });

  it("css 'ease-in-out' (0.42,0,0.58,1) has an easeInOutCubic-like S shape", () => {
    const fn = createBezierEasing(0.42, 0, 0.58, 1);
    // symmetric S-curve: midpoint at 0.5, slow start, fast middle, slow end
    expect(fn(0.5)).toBeCloseTo(0.5, 3);
    expect(fn(0.25)).toBeLessThan(0.25);
    expect(fn(0.75)).toBeGreaterThan(0.75);
    // symmetry: f(t) + f(1-t) ~= 1
    for (const t of [0.1, 0.2, 0.3, 0.4]) {
      expect(fn(t) + fn(1 - t)).toBeCloseTo(1, 3);
    }
    // loosely tracks easeInOutCubic (same qualitative shape; true max deviation ~0.084)
    for (const t of sampleTs) {
      expect(Math.abs(fn(t) - easing.easeInOutCubic(t))).toBeLessThanOrEqual(0.1);
    }
  });

  it('is monotonic non-decreasing for css ease-in-out at 512 sample points', () => {
    const fn = createBezierEasing(0.42, 0, 0.58, 1);
    let prev = fn(0);
    for (let i = 1; i <= SAMPLES; i++) {
      const next = fn(i / SAMPLES);
      expect(next).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = next;
    }
  });

  it('clamps control points outside [0,1] (behaves like the clamped curve)', () => {
    const clamped = createBezierEasing(-1, -5, 3, 7); // -> (0,0,1,1) == linear
    const reference = createBezierEasing(0, 0, 1, 1);
    for (const t of sampleTs) {
      expect(clamped(t)).toBeCloseTo(reference(t), 6);
    }
  });

  it('handles degenerate all-zero control points (0,0,0,0) without NaN', () => {
    const fn = createBezierEasing(0, 0, 0, 0);
    expect(fn(0)).toBeCloseTo(0, 9);
    expect(fn(1)).toBeCloseTo(1, 9);
    for (const t of sampleTs) {
      const v = fn(t);
      expect(Number.isNaN(v)).toBe(false);
      expect(Number.isFinite(v)).toBe(true);
      // x(t) == y(t) == t^3, so the composed function is the identity
      expect(v).toBeCloseTo(t, 4);
    }
  });

  it('handles degenerate all-one control points (1,1,1,1) without NaN', () => {
    const fn = createBezierEasing(1, 1, 1, 1);
    expect(fn(0)).toBeCloseTo(0, 9);
    expect(fn(1)).toBeCloseTo(1, 9);
    for (const t of sampleTs) {
      const v = fn(t);
      expect(Number.isNaN(v)).toBe(false);
      expect(Number.isFinite(v)).toBe(true);
      // x(t) == y(t) == 1-(1-t)^3, so the composed function is the identity
      expect(v).toBeCloseTo(t, 4);
    }
  });

  it('solver converges for extreme control points (0,1,1,0) with outputs in [0,1]', () => {
    const fn = createBezierEasing(0, 1, 1, 0);
    expect(fn(0)).toBeCloseTo(0, 9);
    expect(fn(1)).toBeCloseTo(1, 9);
    for (const t of sampleTs) {
      const v = fn(t);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
    // y'(t) = 3(2t-1)^2 >= 0, so this curve is still monotonic
    expect(fn(0.5)).toBeCloseTo(0.5, 3);
  });

  it('clamps out-of-range t to the [0,1] endpoints', () => {
    const fn = createBezierEasing(0.42, 0, 0.58, 1);
    expect(fn(-0.5)).toBeCloseTo(0, 9);
    expect(fn(-100)).toBeCloseTo(0, 9);
    expect(fn(1.5)).toBeCloseTo(1, 9);
    expect(fn(100)).toBeCloseTo(1, 9);
  });
});

describe('getEasingFunction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the named function for a known name without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getEasingFunction('easeInOutCubic')).toBe(easing.easeInOutCubic);
    expect(getEasingFunction('linear')).toBe(easing.linear);
    expect(getEasingFunction('easeInExpoOutCubic')).toBe(easing.easeInExpoOutCubic);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns linear and warns for an unknown name', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = getEasingFunction('definitelyNotAnEasing');
    expect(fn).toBe(easing.linear);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Easing function "definitelyNotAnEasing" not found, using linear'
    );
  });

  it('returns linear and warns for an empty-string name', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getEasingFunction('')).toBe(easing.linear);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getAllEasingNames', () => {
  it("contains 'easeInOutSine' and 'easeInExpoOutCubic'", () => {
    const names = getAllEasingNames();
    expect(names).toContain('easeInOutSine');
    expect(names).toContain('easeInExpoOutCubic');
  });

  it('matches Object.keys(easing) exactly', () => {
    const names = getAllEasingNames();
    expect(names).toEqual(Object.keys(easing));
    expect(names.length).toBe(Object.keys(easing).length);
  });

  it('every returned name resolves via getEasingFunction without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const name of getAllEasingNames()) {
      expect(getEasingFunction(name)).toBe(easing[name as keyof typeof easing]);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
