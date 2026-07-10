import { describe, expect, it } from 'vitest';
import { getVideoPreviewAspectRatio } from '@/lib/video-preview';

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
