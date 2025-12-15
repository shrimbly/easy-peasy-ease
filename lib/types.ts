/**
 * Shared TypeScript types for the application
 */

export type VideoEncodeCapabilityStatus =
  | 'pending'
  | 'checking'
  | 'supported'
  | 'unsupported'
  | 'error';

export interface VideoEncodeCapability {
  status: VideoEncodeCapabilityStatus;
  message?: string;
  codecString?: string;
  bitrate?: number;
}

export interface TransitionVideo {
  id: number;
  name: string;
  url: string;
  loading: boolean;
  error?: string;
  duration?: number;
  easingPreset?: string;
  useCustomEasing?: boolean;
  customBezier?: [number, number, number, number];
  loopIteration?: number;
  file?: File | Blob;
  cachedBlob?: Blob;
  width?: number;
  height?: number;
  encodeCapability?: VideoEncodeCapability;
}

export interface AudioTrack {
  file: File | Blob;
  url: string; // Object URL for preview/playback
  name: string;
  duration?: number;
}

export interface AudioProcessingOptions {
  fadeIn: number;
  fadeOut: number;
  offset: number;  // Seconds. Positive = audio delayed, Negative = audio trimmed from start
}

export interface FinalVideo {
  blob: Blob;
  url: string; // Object URL for preview/download
  size: number; // File size in bytes
  createdAt: Date;
  audioTrack?: AudioTrack;
}

/**
 * Cache for speed-curved video blobs to avoid re-processing
 * when only audio settings change
 */
export interface SpeedCurvedBlobCache {
  /** Map of segment ID to processed speed-curved blob */
  blobs: Map<number, Blob>;
  /** Hash of segment parameters used to generate these blobs (for cache invalidation) */
  configHash: string;
}

/**
 * Reason for video update - determines which processing path to take
 */
export type UpdateReason =
  | 'full'           // First render or segment params changed - full re-render
  | 'audio-file'     // New audio file uploaded - use cached blobs, re-stitch
  | 'audio-fade'     // Only fade settings changed - remux audio only
  | 'segment-change'; // Segment duration/easing changed - invalidate cache

/**
 * Context passed to finalization to determine which processing path to use
 */
export interface FinalizeContext {
  reason: UpdateReason;
  cachedBlobs?: SpeedCurvedBlobCache;
  previousFinalVideo?: Blob;
  audioBlob?: Blob;
  audioSettings?: AudioProcessingOptions;
}

/**
 * Result from finalization including the final video and cache for reuse
 */
export interface FinalizeResult {
  finalBlob: Blob;
  speedCurvedCache: SpeedCurvedBlobCache;
}
