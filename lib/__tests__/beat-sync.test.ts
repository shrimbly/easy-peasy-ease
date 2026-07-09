import { describe, expect, it } from 'vitest';
import {
  alignOffsetToBeatGrid,
  emphasisAnchorVideoTime,
  firstBeatVideoTime,
  quantizeOffsetToNearestBeat,
  snapDurationsToBeatGrid,
} from '../beat-sync';

const FPS = 60;

describe('snapDurationsToBeatGrid', () => {
  it('snaps each duration to the nearest whole number of beats', () => {
    // 120 BPM → 0.5s per beat.
    const snapped = snapDurationsToBeatGrid([1.4, 0.6, 2.3], 120, 1, FPS);
    expect(snapped[0]).toBeCloseTo(1.5, 5);
    expect(snapped[1]).toBeCloseTo(0.5, 5);
    expect(snapped[2]).toBeCloseTo(2.5, 5);
  });

  it('respects the beats-per-section subdivision', () => {
    const every2 = snapDurationsToBeatGrid([1.4, 1.4], 120, 2, FPS);
    expect(every2[0]).toBeCloseTo(1, 5);
    expect(every2[1]).toBeCloseTo(1, 5);

    const every4 = snapDurationsToBeatGrid([1.4, 3.4], 120, 4, FPS);
    expect(every4[0]).toBeCloseTo(2, 5);
    expect(every4[1]).toBeCloseTo(4, 5);
  });

  it('never returns less than one beat interval per section', () => {
    const snapped = snapDurationsToBeatGrid([0.1, 0.01], 100, 1, FPS);
    const interval = 60 / 100;
    for (const duration of snapped) {
      expect(duration).toBeGreaterThan(interval - 1 / FPS);
    }
  });

  it('keeps cumulative boundaries within half a frame of the beat grid', () => {
    // An awkward tempo where beat intervals are far from frame-aligned.
    const bpm = 127.83;
    const interval = 60 / bpm;
    const durations = Array.from({ length: 24 }, (_, i) => 0.9 + (i % 5) * 0.31);
    const snapped = snapDurationsToBeatGrid(durations, bpm, 1, FPS);
    let cumulative = 0;
    for (const duration of snapped) {
      cumulative += duration;
      const beats = cumulative / interval;
      const drift = Math.abs(beats - Math.round(beats)) * interval;
      expect(drift).toBeLessThanOrEqual(0.5 / FPS + 1e-9);
    }
  });

  it('produces frame-exact durations that survive renderer rounding', () => {
    const snapped = snapDurationsToBeatGrid([1.2, 0.8, 2.1, 1.7], 113.7, 1, FPS);
    for (const duration of snapped) {
      const frames = duration * FPS;
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
    }
  });

  it('defaults to the 30fps grid, which round-trips exactly at BOTH render rates', () => {
    // The renderer encodes each section independently at 30fps (preview /
    // fallback tier) or 60fps (full quality). Boundaries quantized at 60
    // routinely produce odd frame counts whose 30fps rounding always rounds
    // UP — a drift that accumulates section after section. The 30fps grid is
    // exact at both rates (n/30s is 2n frames at 60fps).
    for (const bpm of [113.7, 127.83, 96.04]) {
      const durations = Array.from({ length: 24 }, (_, i) => 0.9 + (i % 5) * 0.31);
      const snapped = snapDurationsToBeatGrid(durations, bpm, 1); // default fps
      for (const renderFps of [30, 60]) {
        let renderedSum = 0;
        let requestedSum = 0;
        for (const duration of snapped) {
          renderedSum += Math.round(duration * renderFps) / renderFps;
          requestedSum += duration;
        }
        expect(Math.abs(renderedSum - requestedSum)).toBeLessThan(1e-6);
      }
    }
  });

  it('is stable when re-applied to its own output', () => {
    const once = snapDurationsToBeatGrid([1.3, 2.2, 0.7], 120, 1, FPS);
    const twice = snapDurationsToBeatGrid(once, 120, 1, FPS);
    for (let i = 0; i < once.length; i++) {
      expect(twice[i]).toBeCloseTo(once[i], 6);
    }
  });

  it('returns the input unchanged for invalid tempo', () => {
    expect(snapDurationsToBeatGrid([1.5, 2], 0, 1, FPS)).toEqual([1.5, 2]);
    expect(snapDurationsToBeatGrid([1.5, 2], NaN, 1, FPS)).toEqual([1.5, 2]);
  });

  it('handles an empty section list', () => {
    expect(snapDurationsToBeatGrid([], 120, 1, FPS)).toEqual([]);
  });
});

describe('alignOffsetToBeatGrid', () => {
  const grid = { period: 0.5, firstBeatOffset: 0.2 };

  it('puts a beat exactly at video time 0', () => {
    for (const offset of [0, 1.23, -0.7, 4.04, -3.33]) {
      const aligned = alignOffsetToBeatGrid(offset, grid);
      const phase = (((aligned + grid.firstBeatOffset) % grid.period) + grid.period) % grid.period;
      expect(Math.min(phase, grid.period - phase)).toBeLessThan(1e-9);
    }
  });

  it('only ever shifts the audio earlier, by less than one beat', () => {
    for (const offset of [0, 1.23, -0.7, 4.04]) {
      const aligned = alignOffsetToBeatGrid(offset, grid);
      expect(aligned).toBeLessThanOrEqual(offset);
      expect(offset - aligned).toBeLessThan(grid.period);
    }
  });

  it('trims the pre-beat intro when starting from no offset', () => {
    expect(alignOffsetToBeatGrid(0, grid)).toBeCloseTo(-0.2, 9);
  });

  it('is idempotent across a sweep of drag-grid offsets', () => {
    // Aligned outputs carry float error that can leave the phase at
    // period - epsilon; a naive re-alignment would then trim a WHOLE extra
    // beat. Sweep the 0.01s drag grid across several beats on both sides.
    for (let k = -200; k <= 200; k++) {
      const offset = k / 100;
      const once = alignOffsetToBeatGrid(offset, grid);
      const twice = alignOffsetToBeatGrid(once, grid);
      expect(Math.abs(twice - once)).toBeLessThan(1e-9);
    }
  });

  it('returns the offset unchanged for an invalid grid', () => {
    expect(alignOffsetToBeatGrid(1.5, { period: 0, firstBeatOffset: 0 })).toBe(1.5);
  });
});

describe('quantizeOffsetToNearestBeat', () => {
  const grid = { period: 0.5, firstBeatOffset: 0.2 };

  it('moves at most half a beat in either direction onto the grid', () => {
    for (let k = -200; k <= 200; k++) {
      const offset = k / 100;
      const quantized = quantizeOffsetToNearestBeat(offset, grid);
      expect(Math.abs(quantized - offset)).toBeLessThanOrEqual(grid.period / 2 + 1e-9);
      const phase =
        (((quantized + grid.firstBeatOffset) % grid.period) + grid.period) % grid.period;
      expect(Math.min(phase, grid.period - phase)).toBeLessThan(1e-9);
    }
  });

  it('leaves an already-aligned offset alone', () => {
    const aligned = alignOffsetToBeatGrid(1.23, grid);
    expect(quantizeOffsetToNearestBeat(aligned, grid)).toBeCloseTo(aligned, 9);
  });
});

describe('tick anchors', () => {
  const grid = { period: 0.5, firstBeatOffset: 0.2 };

  it('firstBeatVideoTime shifts with the offset', () => {
    expect(firstBeatVideoTime(grid, 0)).toBeCloseTo(0.2, 9);
    expect(firstBeatVideoTime(grid, 1)).toBeCloseTo(1.2, 9);
    expect(firstBeatVideoTime(grid, -0.2)).toBeCloseTo(0, 9);
  });

  it('emphasisAnchorVideoTime is the beat nearest video time 0', () => {
    expect(emphasisAnchorVideoTime(grid, 0)).toBeCloseTo(0.2, 9);
    // First beat at 0.3 → beats at ..., -0.2, 0.3, ... — nearest to 0 is -0.2.
    expect(emphasisAnchorVideoTime(grid, 0.1)).toBeCloseTo(-0.2, 9);
    // First beat at 0.45 → nearest beat to 0 is 0.45 - 0.5 = -0.05.
    expect(emphasisAnchorVideoTime(grid, 0.25)).toBeCloseTo(-0.05, 9);
  });

  it('emphasis anchor sits at 0 once the offset is aligned', () => {
    const aligned = alignOffsetToBeatGrid(0.87, grid);
    expect(emphasisAnchorVideoTime(grid, aligned)).toBeCloseTo(0, 9);
  });
});
