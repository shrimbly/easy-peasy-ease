const DEFAULT_VIDEO_ASPECT_RATIO = '16 / 9';

type QuarterTurnRotation = 0 | 90 | 180 | 270;

interface VideoPreviewOrientation {
  expectedWidth?: number;
  expectedHeight?: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
  trackRotation?: QuarterTurnRotation;
}

export function getVideoPreviewAspectRatio(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) {
    return DEFAULT_VIDEO_ASPECT_RATIO;
  }

  return `${width} / ${height}`;
}

export function getVideoPreviewRotationDegrees({
  expectedWidth,
  expectedHeight,
  intrinsicWidth,
  intrinsicHeight,
  trackRotation,
}: VideoPreviewOrientation): number {
  if (
    !expectedWidth ||
    !expectedHeight ||
    expectedWidth <= 0 ||
    expectedHeight <= 0 ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0
  ) {
    return 0;
  }

  const expectedIsPortrait = expectedHeight > expectedWidth;
  const intrinsicIsPortrait = intrinsicHeight > intrinsicWidth;
  if (expectedIsPortrait === intrinsicIsPortrait) {
    return 0;
  }

  if (trackRotation === 90) return -90;
  if (trackRotation === 270) return 90;
  return 0;
}

export function getVideoPreviewTransform(
  orientation: VideoPreviewOrientation
): string {
  const rotationDegrees = getVideoPreviewRotationDegrees(orientation);
  if (rotationDegrees === 0) return 'none';

  const { expectedWidth = 0, expectedHeight = 0 } = orientation;
  const scale = Math.max(
    expectedWidth / expectedHeight,
    expectedHeight / expectedWidth
  );

  return `rotate(${rotationDegrees}deg) scale(${scale})`;
}
