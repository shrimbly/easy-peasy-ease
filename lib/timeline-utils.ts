import { TransitionVideo } from './types';

export interface SegmentBoundary {
  segment: TransitionVideo;
  startTime: number;
  endTime: number;
  index: number;
}

/**
 * Calculate cumulative start and end times for each segment
 */
export function calculateSegmentBoundaries(
  segments: TransitionVideo[]
): SegmentBoundary[] {
  let currentTime = 0;
  const boundaries: SegmentBoundary[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const duration = segment.duration ?? 1.5;

    boundaries.push({
      segment,
      startTime: currentTime,
      endTime: currentTime + duration,
      index: i,
    });

    currentTime += duration;
  }

  return boundaries;
}

/**
 * Get total duration of all segments combined
 */
export function getTotalDuration(segments: TransitionVideo[]): number {
  return segments.reduce((total, segment) => {
    return total + (segment.duration ?? 1.5);
  }, 0);
}

/**
 * Find which segment is currently playing based on time
 */
export function getCurrentSegment(
  currentTime: number,
  segments: TransitionVideo[]
): TransitionVideo | null {
  const totalDuration = getTotalDuration(segments);
  const normalizedTime =
    totalDuration > 0 ? currentTime % totalDuration : currentTime;
  const boundaries = calculateSegmentBoundaries(segments);

  for (const boundary of boundaries) {
    if (normalizedTime >= boundary.startTime && normalizedTime < boundary.endTime) {
      return boundary.segment;
    }
  }

  // If we're at the very end, return the last segment
  if (boundaries.length > 0 && normalizedTime >= boundaries[boundaries.length - 1].endTime) {
    return boundaries[boundaries.length - 1].segment;
  }

  return null;
}

/**
 * Convert time (seconds) to pixel position on timeline based on the zoomed scale
 */
export function timeToPixels(time: number, pixelsPerSecond: number): number {
  if (pixelsPerSecond === 0) return 0;
  return time * pixelsPerSecond;
}

/**
 * Convert pixel position to time (seconds)
 */
export function pixelsToTime(pixels: number, pixelsPerSecond: number): number {
  if (pixelsPerSecond === 0) return 0;
  return pixels / pixelsPerSecond;
}

/**
 * Format time in seconds to MM:SS format
 */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Extract a thumbnail from a video URL
 * Returns a promise that resolves to a data URL
 */
export async function extractVideoThumbnail(
  videoUrl: string,
  timeInSeconds: number = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';

    video.addEventListener('loadeddata', () => {
      // Seek to the specified time
      video.currentTime = timeInSeconds;
    });

    video.addEventListener('seeked', () => {
      try {
        // Create canvas and draw video frame
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert to data URL
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        resolve(dataUrl);
      } catch (error) {
        reject(error);
      } finally {
        video.src = '';
      }
    });

    video.addEventListener('error', (e) => {
      reject(new Error(`Failed to load video: ${e}`));
    });

    video.src = videoUrl;
  });
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
