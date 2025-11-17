/**
 * Shared TypeScript types for the application
 */

export interface GeneratedImage {
  angle: string;
  url: string;
  loading: boolean;
  error?: string;
}

export interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  expires_at: string;
  metrics?: Record<string, unknown>;
}

export interface QwenInput {
  image: string;
  prompt?: string;
  rotate_degrees: number;
  move_forward: number;
  vertical_tilt: number;
  use_wide_angle?: boolean;
  aspect_ratio?: string;
  go_fast?: boolean;
  num_inference_steps?: number;
  output_format?: string;
  output_quality?: number;
}

export interface GeneratedVideo {
  url: string;
  loading: boolean;
  error?: string;
  startTime?: number;
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
}

export interface KlingVideoInput {
  prompt: string;
  image_1?: string;
  image_2?: string;
  duration?: number;
  mode?: 'standard' | 'pro';
}

export interface AudioTrack {
  file: File | Blob;
  url: string; // Object URL for preview/playback
  name: string;
  duration?: number;
}

export interface FinalVideo {
  blob: Blob;
  url: string; // Object URL for preview/download
  size: number; // File size in bytes
  createdAt: Date;
  audioTrack?: AudioTrack;
}
