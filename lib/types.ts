/**
 * Shared TypeScript types for the application
 */

export type RenderQuality = 'preview' | 'full';

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
}

export interface FinalVideo {
  blob: Blob;
  url: string; // Object URL for preview/download
  size: number; // File size in bytes
  createdAt: Date;
  audioTrack?: AudioTrack;
}
