/**
 * Speed Curve Configuration
 * Constants for video processing with Mediabunny
 */

// Video frame rate settings
export const TARGET_FRAME_RATE = 30; // 30 fps source
export const TARGET_FRAME_DURATION = 1 / TARGET_FRAME_RATE; // ~0.0333s

// Output constraints - high fps for smooth ease curve transitions and quality
export const MAX_OUTPUT_FPS = 60; // 60 fps output for smooth easing
export const MIN_OUTPUT_FRAME_DURATION = 1 / MAX_OUTPUT_FPS; // ~0.0167s

// Sample aggregation thresholds
export const MIN_SAMPLE_DURATION = 1 / 60000; // ultra-short aggregation to preserve eased ramps

// Default bitrate / encoder tuning
export const DEFAULT_BITRATE = 12_000_000; // 12 Mbps keeps quality without overloading decoders
export const DEFAULT_KEYFRAME_INTERVAL = 0.5; // seconds between keyframes for stable seeking

// Preview quality settings (720p @ 4Mbps, same framerate)
export const PREVIEW_MAX_WIDTH = 1280;
export const PREVIEW_MAX_HEIGHT = 720;
export const PREVIEW_BITRATE = 4_000_000; // 4 Mbps for fast preview rendering

// Speed curve parameters
export const DEFAULT_INPUT_DURATION = 5; // Kling videos are 5 seconds
export const DEFAULT_OUTPUT_DURATION = 1.5; // Target 1.5s with ease curve
export const DEFAULT_EASING = 'easeInExpoOutCubic'; // Default easing function
