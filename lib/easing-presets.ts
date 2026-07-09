/**
 * Shared easing preset metadata used by the editor UI.
 *
 * The preset set is the monotonic easing curves from https://www.easing.dev/
 * (Lochie Axon). Non-monotonic curves from that set (Anticipate, Overshoot
 * Out, Swift Out) are deliberately excluded: their y-values leave [0, 1],
 * which for a retimed video means playing backwards / overshooting the end.
 *
 * Every preset is a cubic-bezier, so rendering resolves presets through
 * `createBezierEasing` (see resolveEasing in lib/easing-functions.ts) rather
 * than the named math-function table.
 */

export const DEFAULT_CUSTOM_BEZIER: [number, number, number, number] = [0.42, 0, 0.58, 1];

export const PRESET_BEZIERS = {
  Linear: [0, 0, 1, 1],
  In: [0.42, 0, 1, 1],
  Out: [0, 0, 0.58, 1],
  'In Out': [0.42, 0, 0.58, 1],
  'In Out Base': [0.25, 0.1, 0.25, 1],
  'Quick Out': [0, 0, 0.2, 1],
  'Snappy Out': [0.19, 1, 0.22, 1],
  'In Quad': [0.55, 0.085, 0.68, 0.53],
  'In Cubic': [0.55, 0.055, 0.675, 0.19],
  'In Quart': [0.895, 0.03, 0.685, 0.22],
  'In Quint': [0.755, 0.05, 0.855, 0.06],
  'In Expo': [0.95, 0.05, 0.795, 0.035],
  'In Circ': [0.6, 0.04, 0.98, 0.335],
  'Out Quad': [0.25, 0.46, 0.45, 0.94],
  'Out Cubic': [0.215, 0.61, 0.355, 1],
  'Out Quart': [0.165, 0.84, 0.44, 1],
  'Out Quint': [0.23, 1, 0.32, 1],
  'Out Expo': [0.19, 1, 0.22, 1],
  'Out Circ': [0.075, 0.82, 0.165, 1],
  'In Out Quad': [0.455, 0.03, 0.515, 0.955],
  'In Out Cubic': [0.645, 0.045, 0.355, 1],
  'In Out Quart': [0.77, 0, 0.175, 1],
  'In Out Quint': [0.86, 0, 0.07, 1],
  'In Out Expo': [1, 0, 0, 1],
  'In Out Circ': [0.785, 0.135, 0.15, 0.86],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type EasingPresetName = keyof typeof PRESET_BEZIERS;

/** Display order for pickers: base curves first, then In / Out / In Out families. */
export const EASING_PRESETS: EasingPresetName[] = [
  'Linear',
  'In',
  'Out',
  'In Out',
  'In Out Base',
  'Quick Out',
  'Snappy Out',
  'In Quad',
  'In Cubic',
  'In Quart',
  'In Quint',
  'In Expo',
  'In Circ',
  'Out Quad',
  'Out Cubic',
  'Out Quart',
  'Out Quint',
  'Out Expo',
  'Out Circ',
  'In Out Quad',
  'In Out Cubic',
  'In Out Quart',
  'In Out Quint',
  'In Out Expo',
  'In Out Circ',
];

export function getPresetBezier(preset?: string | null): [number, number, number, number] {
  const handles = preset ? PRESET_BEZIERS[preset as EasingPresetName] : null;
  const source = handles ?? DEFAULT_CUSTOM_BEZIER;
  return [...source] as [number, number, number, number];
}
