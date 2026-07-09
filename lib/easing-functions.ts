/**
 * Easing Functions Library
 * Based on easings.net standards
 */

import { PRESET_BEZIERS } from './easing-presets';

export type EasingFunction = (t: number) => number;

const createAsymmetricEase = (easeIn: EasingFunction, easeOut: EasingFunction): EasingFunction => {
  return (t: number): number => {
    if (t <= 0.5) {
      return 0.5 * easeIn(t * 2);
    }
    return 0.5 + 0.5 * easeOut((t - 0.5) * 2);
  };
};

const baseEasing = {
  // Linear - no easing
  linear: (t: number): number => t,

  // Quadratic (Power of 2)
  easeInQuad: (t: number): number => t * t,

  easeOutQuad: (t: number): number => t * (2 - t),

  easeInOutQuad: (t: number): number =>
    t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,

  // Cubic (Power of 3)
  easeInCubic: (t: number): number => t * t * t,

  easeOutCubic: (t: number): number => {
    const t1 = t - 1;
    return t1 * t1 * t1 + 1;
  },

  easeInOutCubic: (t: number): number =>
    t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2,

  // Quartic (Power of 4)
  easeInQuart: (t: number): number => t * t * t * t,

  easeOutQuart: (t: number): number => {
    const t1 = t - 1;
    return 1 - t1 * t1 * t1 * t1;
  },

  easeInOutQuart: (t: number): number =>
    t < 0.5
      ? 8 * t * t * t * t
      : 1 - Math.pow(-2 * t + 2, 4) / 2,

  // Quintic (Power of 5)
  easeInQuint: (t: number): number => t * t * t * t * t,

  easeOutQuint: (t: number): number => {
    const t1 = t - 1;
    return 1 + t1 * t1 * t1 * t1 * t1;
  },

  easeInOutQuint: (t: number): number =>
    t < 0.5
      ? 16 * t * t * t * t * t
      : 1 - Math.pow(-2 * t + 2, 5) / 2,

  // Sinusoidal
  easeInSine: (t: number): number =>
    1 - Math.cos((t * Math.PI) / 2),

  easeOutSine: (t: number): number =>
    Math.sin((t * Math.PI) / 2),

  easeInOutSine: (t: number): number =>
    -(Math.cos(Math.PI * t) - 1) / 2,

  // Exponential
  easeInExpo: (t: number): number =>
    t === 0 ? 0 : Math.pow(2, 10 * t - 10),

  easeOutExpo: (t: number): number =>
    t === 1 ? 1 : 1 - Math.pow(2, -10 * t),

  easeInOutExpo: (t: number): number =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? Math.pow(2, 20 * t - 10) / 2
          : (2 - Math.pow(2, -20 * t + 10)) / 2,

  // Circular
  easeInCirc: (t: number): number =>
    1 - Math.sqrt(1 - Math.pow(t, 2)),

  easeOutCirc: (t: number): number =>
    Math.sqrt(1 - Math.pow(t - 1, 2)),

  easeInOutCirc: (t: number): number =>
    t < 0.5
      ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
      : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,
} as const;

const hybridEasing = {
  easeInExpoOutCubic: createAsymmetricEase(baseEasing.easeInExpo, baseEasing.easeOutCubic),
  easeInQuartOutQuad: createAsymmetricEase(baseEasing.easeInQuart, baseEasing.easeOutQuad),
} as const;

export const easing = {
  ...baseEasing,
  ...hybridEasing,
} as const;

export function createBezierEasing(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number
): EasingFunction {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x1 = clamp(p1x);
  const y1 = clamp(p1y);
  const x2 = clamp(p2x);
  const y2 = clamp(p2y);

  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;

  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleCurveX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleCurveY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDerivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveCurveX = (x: number) => {
    let t2 = x;
    const epsilon = 1e-6;

    for (let i = 0; i < 8; i++) {
      const x2 = sampleCurveX(t2) - x;
      if (Math.abs(x2) < epsilon) {
        return t2;
      }
      const d2 = sampleDerivativeX(t2);
      if (Math.abs(d2) < epsilon) {
        break;
      }
      t2 -= x2 / d2;
    }

    let t0 = 0;
    let t1 = 1;
    t2 = x;

    while (t0 < t1) {
      const x2 = sampleCurveX(t2);
      if (Math.abs(x2 - x) < epsilon) {
        return t2;
      }
      if (x > x2) {
        t0 = t2;
      } else {
        t1 = t2;
      }
      t2 = (t1 + t0) / 2;
    }

    return t2;
  };

  return (t: number) => {
    const clamped = clamp(t);
    return sampleCurveY(solveCurveX(clamped));
  };
}

/**
 * Get easing function by name
 */
export function getEasingFunction(name: string): EasingFunction {
  const func = easing[name as keyof typeof easing];
  if (!func) {
    console.warn(`Easing function "${name}" not found, using linear`);
    return easing.linear;
  }
  return func;
}

/**
 * Get all available easing function names
 */
export function getAllEasingNames(): string[] {
  return Object.keys(easing);
}

/**
 * Resolve any easing reference to a callable function. Preset names (the
 * cubic-bezier curves in lib/easing-presets) take priority; other strings
 * fall back to the named math functions above.
 */
export function resolveEasing(easingRef: string | EasingFunction): EasingFunction {
  if (typeof easingRef !== 'string') {
    return easingRef;
  }
  const bezier = PRESET_BEZIERS[easingRef as keyof typeof PRESET_BEZIERS];
  if (bezier) {
    return createBezierEasing(bezier[0], bezier[1], bezier[2], bezier[3]);
  }
  return getEasingFunction(easingRef);
}
