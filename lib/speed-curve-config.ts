/**
 * Speed Curve Configuration
 * Constants for video processing with Mediabunny
 */

// Video frame rate settings
export const TARGET_FRAME_RATE = 30; // 30 fps source
export const TARGET_FRAME_DURATION = 1 / TARGET_FRAME_RATE; // ~0.0333s

// Output constraints - max fps for final quality rendering
export const MAX_OUTPUT_FPS = 60; // 60 fps output for smooth easing
export const MIN_OUTPUT_FRAME_DURATION = 1 / MAX_OUTPUT_FPS; // ~0.0167s

// Preview fps (lower for faster rendering)
export const PREVIEW_FPS = 30;

// Sample aggregation thresholds
export const MIN_SAMPLE_DURATION = 1 / 60000; // ultra-short aggregation to preserve eased ramps

// Default bitrate / encoder tuning
export const DEFAULT_BITRATE = 25_000_000; // 25 Mbps baseline to preserve quality from high-bitrate sources
export const DEFAULT_KEYFRAME_INTERVAL = 1.0; // 1 second between keyframes - balances compression with stitching compatibility

// Preview quality settings (720p @ 4Mbps, same framerate)
export const PREVIEW_MAX_WIDTH = 1280;
export const PREVIEW_MAX_HEIGHT = 720;
export const PREVIEW_BITRATE = 4_000_000; // 4 Mbps for fast preview rendering

// Speed curve parameters
export const DEFAULT_INPUT_DURATION = 5; // Kling videos are 5 seconds
export const DEFAULT_OUTPUT_DURATION = 1.5; // Target 1.5s with ease curve
export const DEFAULT_EASING = 'easeInOutSine'; // Default easing function
