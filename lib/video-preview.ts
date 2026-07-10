const DEFAULT_VIDEO_ASPECT_RATIO = '16 / 9';

export function getVideoPreviewAspectRatio(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) {
    return DEFAULT_VIDEO_ASPECT_RATIO;
  }

  return `${width} / ${height}`;
}
