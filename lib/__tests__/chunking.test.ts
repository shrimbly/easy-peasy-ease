import { describe, it, expect } from 'vitest';
import {
  MIN_SECTION_DURATION,
  MAX_SECTIONS,
  sanitizeSplitTimes,
  deriveSections,
  sectionCountForLength,
  computeEvenSplitTimes,
  computeSplitTimesByCount,
  canInsertSplit,
  insertSplit,
  removeSplit,
  moveSplit,
  buildSectionSegments,
  type Section,
  type SplitSource,
} from '@/lib/chunking';

/** Sections must tile [0, duration] with no gaps or overlaps. */
function expectContiguous(sections: Section[], duration: number) {
  expect(sections.length).toBeGreaterThan(0);
  expect(sections[0].start).toBeCloseTo(0, 6);
  expect(sections[sections.length - 1].end).toBeCloseTo(duration, 6);
  for (let i = 0; i < sections.length; i++) {
    expect(sections[i].index).toBe(i);
    expect(sections[i].duration).toBeGreaterThan(0);
    expect(sections[i].end - sections[i].start).toBeCloseTo(sections[i].duration, 6);
    if (i > 0) {
      expect(sections[i].start).toBeCloseTo(sections[i - 1].end, 6);
    }
  }
}

describe('sanitizeSplitTimes', () => {
  it('returns [] for non-positive or non-finite durations', () => {
    expect(sanitizeSplitTimes(0, [1, 2])).toEqual([]);
    expect(sanitizeSplitTimes(-5, [1])).toEqual([]);
    expect(sanitizeSplitTimes(NaN, [1])).toEqual([]);
  });

  it('sorts, clamps, and drops non-finite entries', () => {
    expect(sanitizeSplitTimes(10, [7, 3, NaN, Infinity, 5])).toEqual([3, 5, 7]);
  });

  it('drops splits within minGap of each other (keeps the earlier)', () => {
    // 5.0 and 5.1 are closer than MIN_SECTION_DURATION (0.3)
    expect(sanitizeSplitTimes(10, [5.0, 5.1])).toEqual([5.0]);
  });

  it('drops splits too close to the 0 boundary', () => {
    expect(sanitizeSplitTimes(10, [0.1])).toEqual([]);
  });

  it('drops splits too close to the duration boundary', () => {
    expect(sanitizeSplitTimes(10, [9.95])).toEqual([]);
  });

  it('clamps out-of-range splits into the interval before gap checks', () => {
    // 12 clamps to 10 (== duration) then fails the tail gap check -> dropped
    expect(sanitizeSplitTimes(10, [12])).toEqual([]);
    // -3 clamps to 0 then fails the head gap check -> dropped
    expect(sanitizeSplitTimes(10, [-3])).toEqual([]);
  });
});

describe('deriveSections', () => {
  it('returns a single full-length section when there are no splits', () => {
    const sections = deriveSections(10, []);
    expect(sections).toEqual([{ index: 0, start: 0, end: 10, duration: 10 }]);
  });

  it('returns [] for a zero/invalid duration', () => {
    expect(deriveSections(0, [])).toEqual([]);
    expect(deriveSections(NaN, [1])).toEqual([]);
  });

  it('splits into contiguous sections', () => {
    const sections = deriveSections(15, [5, 10]);
    expect(sections).toEqual([
      { index: 0, start: 0, end: 5, duration: 5 },
      { index: 1, start: 5, end: 10, duration: 5 },
      { index: 2, start: 10, end: 15, duration: 5 },
    ]);
    expectContiguous(sections, 15);
  });

  it('sanitises invalid splits before deriving', () => {
    const sections = deriveSections(15, [10, 5, 5.05]); // out of order + too close
    expect(sections.map((s) => s.start)).toEqual([0, 5, 10]);
    expectContiguous(sections, 15);
  });
});

describe('sectionCountForLength', () => {
  it('divides evenly', () => {
    expect(sectionCountForLength(20, 5)).toBe(4);
  });
  it('rounds up a partial trailing section', () => {
    expect(sectionCountForLength(22, 5)).toBe(5); // 4 full + remainder
  });
  it('always matches the sections computeEvenSplitTimes actually produces', () => {
    for (const [d, len] of [
      [10.1, 5], // folded remainder -> 2, not the naive ceil of 3
      [22, 5],
      [20, 5],
      [7, 3],
      [100, 0.05], // capped
    ] as const) {
      expect(sectionCountForLength(d, len)).toBe(
        deriveSections(d, computeEvenSplitTimes(d, len)).length
      );
    }
    expect(sectionCountForLength(10.1, 5)).toBe(2);
  });
  it('never exceeds MAX_SECTIONS', () => {
    expect(sectionCountForLength(1000, 0.01)).toBe(MAX_SECTIONS);
  });
  it('is at least 1 for a valid source', () => {
    expect(sectionCountForLength(3, 5)).toBe(1);
  });
  it('is 0 for invalid inputs', () => {
    expect(sectionCountForLength(0, 5)).toBe(0);
    expect(sectionCountForLength(10, 0)).toBe(0);
  });
});

describe('computeEvenSplitTimes', () => {
  it('produces evenly spaced interior splits', () => {
    expect(computeEvenSplitTimes(20, 5)).toEqual([5, 10, 15]);
  });

  it('always yields contiguous sections of about the requested length', () => {
    const duration = 23;
    const sections = deriveSections(duration, computeEvenSplitTimes(duration, 5));
    expectContiguous(sections, duration);
    // Every section except possibly the last is exactly 5s.
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].duration).toBeCloseTo(5, 6);
    }
  });

  it('folds a tiny trailing remainder into the previous section', () => {
    // 10.1 / 5 -> splits at 5, 10; tail (0.1) < minGap, so the 10 split is
    // dropped and the last section becomes 5.1s instead of a 0.1s stub.
    const splits = computeEvenSplitTimes(10.1, 5);
    expect(splits).toEqual([5]);
    const sections = deriveSections(10.1, splits);
    expect(sections).toHaveLength(2);
    expect(sections[1].duration).toBeCloseTo(5.1, 6);
  });

  it('never exceeds MAX_SECTIONS even for a tiny section length', () => {
    const sections = deriveSections(60, computeEvenSplitTimes(60, 0.05));
    expect(sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
    expectContiguous(sections, 60);
  });

  it('returns [] (one full section) when the source is shorter than a section', () => {
    expect(computeEvenSplitTimes(4, 5)).toEqual([]);
  });

  it('returns [] for invalid inputs', () => {
    expect(computeEvenSplitTimes(0, 5)).toEqual([]);
    expect(computeEvenSplitTimes(10, 0)).toEqual([]);
  });
});

describe('computeSplitTimesByCount', () => {
  it('divides into N equal sections', () => {
    expect(computeSplitTimesByCount(12, 3)).toEqual([4, 8]);
  });

  it('produces contiguous equal sections', () => {
    const sections = deriveSections(12, computeSplitTimesByCount(12, 4));
    expect(sections).toHaveLength(4);
    sections.forEach((s) => expect(s.duration).toBeCloseTo(3, 6));
  });

  it('returns [] for a count of 1 or less', () => {
    expect(computeSplitTimesByCount(10, 1)).toEqual([]);
    expect(computeSplitTimesByCount(10, 0)).toEqual([]);
  });

  it('caps the count at MAX_SECTIONS', () => {
    const splits = computeSplitTimesByCount(1000, 999);
    // MAX_SECTIONS sections => MAX_SECTIONS - 1 interior splits
    expect(splits.length).toBe(MAX_SECTIONS - 1);
  });
});

describe('canInsertSplit', () => {
  it('rejects splits at or outside the boundaries', () => {
    expect(canInsertSplit([], 0, 10)).toBe(false);
    expect(canInsertSplit([], 10, 10)).toBe(false);
    expect(canInsertSplit([], -1, 10)).toBe(false);
  });

  it('accepts a well-separated split', () => {
    expect(canInsertSplit([5], 2, 10)).toBe(true);
  });

  it('rejects a split too close to an existing one', () => {
    expect(canInsertSplit([5], 5.1, 10)).toBe(false);
  });

  it('rejects once MAX_SECTIONS is reached', () => {
    const splits = computeSplitTimesByCount(MAX_SECTIONS, MAX_SECTIONS); // MAX_SECTIONS sections
    expect(canInsertSplit(splits, 0.5, MAX_SECTIONS)).toBe(false);
  });
});

describe('insertSplit / removeSplit / moveSplit', () => {
  it('inserts a valid split in sorted order', () => {
    expect(insertSplit([5], 2, 10)).toEqual([2, 5]);
  });

  it('ignores an invalid insert (too close), returning the sanitised list', () => {
    expect(insertSplit([5], 5.1, 10)).toEqual([5]);
  });

  it('removes a split by index', () => {
    expect(removeSplit([2, 5, 8], 1, 10)).toEqual([2, 8]);
  });

  it('ignores an out-of-range remove index', () => {
    expect(removeSplit([2, 5], 9, 10)).toEqual([2, 5]);
  });

  it('moves a split, clamping between its neighbours', () => {
    // Try to drag the middle split (5) past its right neighbour (8).
    const moved = moveSplit([2, 5, 8], 1, 20, 10);
    expect(moved[1]).toBeCloseTo(8 - MIN_SECTION_DURATION, 6);
    expect(moved[0]).toBe(2);
    expect(moved[2]).toBe(8);
  });

  it('clamps a move against the lower neighbour', () => {
    const moved = moveSplit([2, 5, 8], 1, 0, 10);
    expect(moved[1]).toBeCloseTo(2 + MIN_SECTION_DURATION, 6);
  });

  it('keeps neighbours fixed and the section count stable while moving', () => {
    const moved = moveSplit([2, 5, 8], 1, 6.5, 10);
    expect(moved[0]).toBe(2);
    expect(moved[2]).toBe(8);
    expect(moved[1]).toBeCloseTo(6.5, 6);
    // 3 interior splits => 4 contiguous sections.
    expect(deriveSections(10, moved)).toHaveLength(4);
  });

  it('returns the sanitised list unchanged for an out-of-range move index', () => {
    expect(moveSplit([2, 5], 9, 3, 10)).toEqual([2, 5]);
  });
});

describe('buildSectionSegments', () => {
  const source: SplitSource = {
    file: new Blob(['x'], { type: 'video/mp4' }) as unknown as File,
    name: 'long.mp4',
    width: 1920,
    height: 1080,
    encodeCapability: { status: 'supported' },
  };

  it('creates one segment per section carrying its source range', () => {
    const sections = deriveSections(15, [5, 10]);
    let n = 0;
    const segments = buildSectionSegments(
      source,
      sections,
      { outputDuration: 1.5, easingPreset: 'easeInOutSine' },
      () => `blob:url-${n++}`
    );

    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(segments.map((s) => s.name)).toEqual(['Section 1', 'Section 2', 'Section 3']);
    expect(segments.map((s) => [s.sourceStartTime, s.sourceEndTime])).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
    ]);
    // Each segment shares the source file but gets a distinct object URL.
    expect(new Set(segments.map((s) => s.url)).size).toBe(3);
    segments.forEach((s) => {
      expect(s.file).toBe(source.file);
      expect(s.duration).toBe(1.5);
      expect(s.easingPreset).toBe('easeInOutSine');
      expect(s.width).toBe(1920);
      expect(s.height).toBe(1080);
      expect(s.encodeCapability).toEqual({ status: 'supported' });
      expect(s.loopIteration).toBe(1);
      expect(s.useCustomEasing).toBe(false);
      expect(s.customBezier).toHaveLength(4);
    });
  });

  it('falls back to defaults for invalid/absent options', () => {
    const sections = deriveSections(10, []);
    const [segment] = buildSectionSegments(source, sections, {}, () => 'blob:x');
    expect(segment.duration).toBeGreaterThan(0);
    expect(typeof segment.easingPreset).toBe('string');
  });
});
