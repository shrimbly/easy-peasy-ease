import { describe, it, expect } from 'vitest';
import {
  calculateSegmentBoundaries,
  getTotalDuration,
  getCurrentSegment,
  timeToPixels,
  pixelsToTime,
  formatTime,
  clamp,
} from '@/lib/timeline-utils';
import type { TransitionVideo } from '@/lib/types';
// Static import is safe under jsdom: useFinalizeVideo pulls in mediabunny
// transitively via other hooks, but nothing WebCodecs-related executes at
// module load time, and the hook body itself never runs in these tests.
import { computeConfigHash } from '@/hooks/useFinalizeVideo';
import { DEFAULT_EASING } from '@/lib/speed-curve-config';

/** Build a minimal valid TransitionVideo, overridable per test. */
function makeVideo(overrides: Partial<TransitionVideo> = {}): TransitionVideo {
  return {
    id: overrides.id ?? 1,
    name: 'clip.mp4',
    url: 'blob:http://localhost/abc',
    loading: false,
    ...overrides,
  };
}

describe('calculateSegmentBoundaries', () => {
  it('returns an empty array for no segments', () => {
    expect(calculateSegmentBoundaries([])).toEqual([]);
  });

  it('computes cumulative start/end times from explicit durations', () => {
    const segments = [
      makeVideo({ id: 1, duration: 2 }),
      makeVideo({ id: 2, duration: 0.5 }),
      makeVideo({ id: 3, duration: 3 }),
    ];
    const boundaries = calculateSegmentBoundaries(segments);

    expect(boundaries).toHaveLength(3);
    expect(boundaries[0].startTime).toBe(0);
    expect(boundaries[0].endTime).toBe(2);
    expect(boundaries[1].startTime).toBe(2);
    expect(boundaries[1].endTime).toBe(2.5);
    expect(boundaries[2].startTime).toBe(2.5);
    expect(boundaries[2].endTime).toBe(5.5);
  });

  it('defaults missing durations to 1.5 seconds', () => {
    const segments = [makeVideo({ id: 1 }), makeVideo({ id: 2 }), makeVideo({ id: 3 })];
    const boundaries = calculateSegmentBoundaries(segments);

    expect(boundaries[0].startTime).toBe(0);
    expect(boundaries[0].endTime).toBe(1.5);
    expect(boundaries[1].startTime).toBe(1.5);
    expect(boundaries[1].endTime).toBe(3);
    expect(boundaries[2].startTime).toBe(3);
    expect(boundaries[2].endTime).toBe(4.5);
  });

  it('carries the segment reference and its index', () => {
    const segments = [makeVideo({ id: 10 }), makeVideo({ id: 20 })];
    const boundaries = calculateSegmentBoundaries(segments);

    expect(boundaries[0].segment).toBe(segments[0]);
    expect(boundaries[0].index).toBe(0);
    expect(boundaries[1].segment).toBe(segments[1]);
    expect(boundaries[1].index).toBe(1);
  });

  it('mixes explicit and default durations cumulatively', () => {
    const segments = [makeVideo({ id: 1, duration: 1 }), makeVideo({ id: 2 })];
    const boundaries = calculateSegmentBoundaries(segments);

    expect(boundaries[1].startTime).toBe(1);
    expect(boundaries[1].endTime).toBe(2.5);
  });
});

describe('getTotalDuration', () => {
  it('returns 0 for an empty list', () => {
    expect(getTotalDuration([])).toBe(0);
  });

  it('sums explicit durations', () => {
    const segments = [
      makeVideo({ id: 1, duration: 2 }),
      makeVideo({ id: 2, duration: 3.5 }),
    ];
    expect(getTotalDuration(segments)).toBe(5.5);
  });

  it('uses the 1.5s default for missing durations', () => {
    const segments = [makeVideo({ id: 1 }), makeVideo({ id: 2, duration: 1 })];
    expect(getTotalDuration(segments)).toBe(2.5);
  });
});

describe('getCurrentSegment', () => {
  const segments = [
    makeVideo({ id: 1, duration: 1.5 }),
    makeVideo({ id: 2, duration: 1.5 }),
    makeVideo({ id: 3, duration: 2 }),
  ]; // boundaries: [0,1.5), [1.5,3), [3,5); total 5

  it('returns null for an empty list', () => {
    expect(getCurrentSegment(0, [])).toBeNull();
    expect(getCurrentSegment(3, [])).toBeNull();
  });

  it('finds the segment for a mid-segment time', () => {
    expect(getCurrentSegment(0.7, segments)?.id).toBe(1);
    expect(getCurrentSegment(2.2, segments)?.id).toBe(2);
    expect(getCurrentSegment(4.9, segments)?.id).toBe(3);
  });

  it('returns the first segment at time 0', () => {
    expect(getCurrentSegment(0, segments)?.id).toBe(1);
  });

  it('assigns an exact boundary time to the next segment', () => {
    expect(getCurrentSegment(1.5, segments)?.id).toBe(2);
    expect(getCurrentSegment(3, segments)?.id).toBe(3);
  });

  it('wraps times beyond the total duration via modulo', () => {
    // 5.7 % 5 = 0.7 -> first segment
    expect(getCurrentSegment(5.7, segments)?.id).toBe(1);
    // 12.2 % 5 = 2.2 -> second segment
    expect(getCurrentSegment(12.2, segments)?.id).toBe(2);
  });

  it('wraps an exact multiple of the total duration to the first segment', () => {
    expect(getCurrentSegment(5, segments)?.id).toBe(1);
    expect(getCurrentSegment(10, segments)?.id).toBe(1);
  });

  it('works for a single segment with default duration', () => {
    const single = [makeVideo({ id: 42 })];
    expect(getCurrentSegment(0.75, single)?.id).toBe(42);
    // wraps: 1.6 % 1.5 = 0.1
    expect(getCurrentSegment(1.6, single)?.id).toBe(42);
  });
});

describe('timeToPixels / pixelsToTime', () => {
  it('converts time to pixels linearly', () => {
    expect(timeToPixels(2, 50)).toBe(100);
    expect(timeToPixels(0, 50)).toBe(0);
    expect(timeToPixels(1.5, 10)).toBe(15);
  });

  it('converts pixels to time linearly', () => {
    expect(pixelsToTime(100, 50)).toBe(2);
    expect(pixelsToTime(0, 50)).toBe(0);
    expect(pixelsToTime(15, 10)).toBe(1.5);
  });

  it('round-trips time -> pixels -> time', () => {
    for (const pps of [1, 30, 50, 123.45]) {
      for (const t of [0, 0.25, 1.5, 59.99, 1000]) {
        expect(pixelsToTime(timeToPixels(t, pps), pps)).toBeCloseTo(t, 10);
      }
    }
  });

  it('round-trips pixels -> time -> pixels', () => {
    for (const pps of [1, 30, 50, 123.45]) {
      for (const px of [0, 1, 37.5, 1920]) {
        expect(timeToPixels(pixelsToTime(px, pps), pps)).toBeCloseTo(px, 10);
      }
    }
  });

  it('guards against zero pixelsPerSecond', () => {
    expect(timeToPixels(10, 0)).toBe(0);
    expect(pixelsToTime(500, 0)).toBe(0);
  });
});

describe('formatTime', () => {
  it("formats 0 as '00:00'", () => {
    expect(formatTime(0)).toBe('00:00');
  });

  it("formats 65 as '01:05'", () => {
    expect(formatTime(65)).toBe('01:05');
  });

  it("formats 3599 as '59:59'", () => {
    expect(formatTime(3599)).toBe('59:59');
  });

  it('floors fractional seconds', () => {
    expect(formatTime(65.9)).toBe('01:05');
    expect(formatTime(0.4)).toBe('00:00');
  });

  it('pads single-digit minutes and seconds', () => {
    expect(formatTime(61)).toBe('01:01');
    expect(formatTime(9)).toBe('00:09');
    expect(formatTime(600)).toBe('10:00');
  });
});

describe('clamp', () => {
  it('returns the value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps below the minimum', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it('clamps above the maximum', () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('is inclusive at the boundaries', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('handles negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(0, -10, -1)).toBe(-1);
    expect(clamp(-20, -10, -1)).toBe(-10);
  });
});

describe('computeConfigHash', () => {
  it('is exported as a function', () => {
    expect(typeof computeConfigHash).toBe('function');
  });

  const baseVideos = (): TransitionVideo[] => [
    makeVideo({
      id: 1,
      duration: 1.5,
      easingPreset: 'easeInOutSine',
      file: new Blob(['aaaa']), // size 4
    }),
    makeVideo({
      id: 2,
      duration: 2,
      easingPreset: 'easeOutQuad',
      customBezier: [0.1, 0.2, 0.3, 0.4],
      useCustomEasing: true,
      file: new Blob(['bbbbbb']), // size 6
    }),
  ];

  it('is deterministic for identical input', () => {
    expect(computeConfigHash(baseVideos(), 'full', 5)).toBe(
      computeConfigHash(baseVideos(), 'full', 5)
    );
  });

  it('differs when quality changes', () => {
    const videos = baseVideos();
    expect(computeConfigHash(videos, 'preview', 5)).not.toBe(
      computeConfigHash(videos, 'full', 5)
    );
  });

  it('differs when inputDuration changes', () => {
    const videos = baseVideos();
    expect(computeConfigHash(videos, 'full', 5)).not.toBe(
      computeConfigHash(videos, 'full', 10)
    );
  });

  it('differs when a segment duration changes', () => {
    const a = baseVideos();
    const b = baseVideos();
    b[0].duration = 3;
    expect(computeConfigHash(a, 'full', 5)).not.toBe(computeConfigHash(b, 'full', 5));
  });

  it('differs when an easingPreset changes', () => {
    const a = baseVideos();
    const b = baseVideos();
    b[0].easingPreset = 'easeInCubic';
    expect(computeConfigHash(a, 'full', 5)).not.toBe(computeConfigHash(b, 'full', 5));
  });

  it('differs when customBezier changes', () => {
    const a = baseVideos();
    const b = baseVideos();
    b[1].customBezier = [0.9, 0.2, 0.3, 0.4];
    expect(computeConfigHash(a, 'full', 5)).not.toBe(computeConfigHash(b, 'full', 5));
  });

  it('differs when useCustomEasing changes', () => {
    const a = baseVideos();
    const b = baseVideos();
    b[1].useCustomEasing = false;
    expect(computeConfigHash(a, 'full', 5)).not.toBe(computeConfigHash(b, 'full', 5));
  });

  it('differs when the source file size changes', () => {
    const a = baseVideos();
    const b = baseVideos();
    b[0].file = new Blob(['aaaaaaaa']); // size 8 instead of 4
    expect(computeConfigHash(a, 'full', 5)).not.toBe(computeConfigHash(b, 'full', 5));
  });

  it('falls back to cachedBlob size when file is absent', () => {
    const a = baseVideos();
    const b = baseVideos();
    delete a[0].file;
    delete b[0].file;
    a[0].cachedBlob = new Blob(['xx']); // size 2
    b[0].cachedBlob = new Blob(['xxxx']); // size 4
    expect(computeConfigHash(a, 'full', 5)).not.toBe(computeConfigHash(b, 'full', 5));
    // and same size -> same hash
    const c = baseVideos();
    delete c[0].file;
    c[0].cachedBlob = new Blob(['yy']); // size 2, different content
    expect(computeConfigHash(a, 'full', 5)).toBe(computeConfigHash(c, 'full', 5));
  });

  it('ignores irrelevant field changes such as name and error', () => {
    const a = baseVideos();
    const b = baseVideos();
    b[0].name = 'totally-different.mp4';
    b[1].error = 'something happened earlier';
    b[0].loopIteration = 99;
    expect(computeConfigHash(a, 'full', 5)).toBe(computeConfigHash(b, 'full', 5));
  });

  it('filters out segments without a url', () => {
    const withUrl = [makeVideo({ id: 1, duration: 2 })];
    const withExtra = [
      makeVideo({ id: 1, duration: 2 }),
      makeVideo({ id: 2, url: '', duration: 9 }),
    ];
    expect(computeConfigHash(withExtra, 'full', 5)).toBe(
      computeConfigHash(withUrl, 'full', 5)
    );
  });

  it('filters out segments that are still loading', () => {
    const withUrl = [makeVideo({ id: 1, duration: 2 })];
    const withLoading = [
      makeVideo({ id: 1, duration: 2 }),
      makeVideo({ id: 2, loading: true, duration: 9 }),
    ];
    expect(computeConfigHash(withLoading, 'full', 5)).toBe(
      computeConfigHash(withUrl, 'full', 5)
    );
  });

  it('applies defaults so omitted optional fields hash like explicit defaults', () => {
    const implicit = [makeVideo({ id: 1 })];
    const explicit = [
      makeVideo({
        id: 1,
        duration: 1.5, // DEFAULT_OUTPUT_DURATION
        easingPreset: DEFAULT_EASING,
        useCustomEasing: false,
      }),
    ];
    expect(computeConfigHash(implicit, 'full', 5)).toBe(
      computeConfigHash(explicit, 'full', 5)
    );
  });

  it('produces an empty-segment hash when every segment is filtered out', () => {
    const videos = [
      makeVideo({ id: 1, url: '' }),
      makeVideo({ id: 2, loading: true }),
    ];
    expect(computeConfigHash(videos, 'full', 5)).toBe(
      computeConfigHash([], 'full', 5)
    );
  });

  it('differs when a segment id changes', () => {
    const a = [makeVideo({ id: 1, duration: 2 })];
    const b = [makeVideo({ id: 7, duration: 2 })];
    expect(computeConfigHash(a, 'full', 5)).not.toBe(computeConfigHash(b, 'full', 5));
  });
});
