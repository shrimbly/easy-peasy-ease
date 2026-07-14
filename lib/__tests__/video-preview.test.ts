import { describe, expect, it } from 'vitest';
import {
  getGeneratedVideoPreviewTransform,
  getVideoPreviewAspectRatio,
  getVideoPreviewRotationDegrees,
  getVideoPreviewTransform,
} from '@/lib/video-preview';

describe('getVideoPreviewAspectRatio', () => {
  it('keeps portrait display dimensions in portrait orientation', () => {
    expect(getVideoPreviewAspectRatio(1080, 1920)).toBe('1080 / 1920');
  });

  it('keeps landscape display dimensions in landscape orientation', () => {
    expect(getVideoPreviewAspectRatio(1920, 1080)).toBe('1920 / 1080');
  });

  it('falls back to widescreen when dimensions are unavailable or invalid', () => {
    expect(getVideoPreviewAspectRatio()).toBe('16 / 9');
    expect(getVideoPreviewAspectRatio(0, 1920)).toBe('16 / 9');
    expect(getVideoPreviewAspectRatio(1080, -1)).toBe('16 / 9');
  });
});

describe('getGeneratedVideoPreviewTransform', () => {
  it('undoes carried rotation even when generated video dimensions already look correct', () => {
    expect(
      getGeneratedVideoPreviewTransform({
        expectedWidth: 1080,
        expectedHeight: 1350,
        trackRotation: 90,
      })
    ).toBe('rotate(-90deg) scale(1.25)');
  });

  it('preserves a carried half-turn without swapping the preview dimensions', () => {
    expect(
      getGeneratedVideoPreviewTransform({
        expectedWidth: 1080,
        expectedHeight: 1350,
        trackRotation: 180,
      })
    ).toBe('rotate(180deg)');
  });
});

describe('getVideoPreviewRotationDegrees', () => {
  it('undoes a clockwise track rotation when a portrait preview is exposed as landscape', () => {
    expect(
      getVideoPreviewRotationDegrees({
        expectedWidth: 1080,
        expectedHeight: 1350,
        intrinsicWidth: 1350,
        intrinsicHeight: 1080,
        trackRotation: 90,
      })
    ).toBe(-90);
  });

  it('undoes a counter-clockwise track rotation in the opposite direction', () => {
    expect(
      getVideoPreviewRotationDegrees({
        expectedWidth: 1080,
        expectedHeight: 1350,
        intrinsicWidth: 1350,
        intrinsicHeight: 1080,
        trackRotation: 270,
      })
    ).toBe(90);
  });

  it('does not rotate when the browser intrinsic orientation already matches', () => {
    expect(
      getVideoPreviewRotationDegrees({
        expectedWidth: 1080,
        expectedHeight: 1350,
        intrinsicWidth: 1080,
        intrinsicHeight: 1350,
        trackRotation: 90,
      })
    ).toBe(0);
  });
});

describe('getVideoPreviewTransform', () => {
  it('rotates and scales a landscape-coded 4:5 preview into its display box', () => {
    expect(
      getVideoPreviewTransform({
        expectedWidth: 1080,
        expectedHeight: 1350,
        intrinsicWidth: 1350,
        intrinsicHeight: 1080,
        trackRotation: 90,
      })
    ).toBe('rotate(-90deg) scale(1.25)');
  });

  it('leaves an already-correct preview untouched', () => {
    expect(
      getVideoPreviewTransform({
        expectedWidth: 1080,
        expectedHeight: 1350,
        intrinsicWidth: 1080,
        intrinsicHeight: 1350,
        trackRotation: 90,
      })
    ).toBe('none');
  });
});
