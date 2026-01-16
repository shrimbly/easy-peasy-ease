import { AVC_LEVEL_4_0, AVC_LEVEL_5_1 } from './video-encoding';
import { calculateAspectRatioConsistency } from './utils';
import { PreflightWarning, TransitionVideo, VideoMetadata } from './types';

const FOUR_K_WIDTH = 3840;
const FOUR_K_HEIGHT = 2160;
const MAX_TOTAL_SIZE_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5GB

export const readVideoMetadata = (file: File | Blob): Promise<VideoMetadata> =>
    new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;

        const cleanup = () => {
            video.removeAttribute('src');
            video.load();
            URL.revokeObjectURL(url);
        };

        video.onloadedmetadata = () => {
            const width = video.videoWidth;
            const height = video.videoHeight;
            const duration = Number.isFinite(video.duration) ? video.duration : 0;
            cleanup();
            if (!width || !height) {
                reject(new Error('Unable to determine video dimensions.'));
                return;
            }
            resolve({ width, height, duration });
        };

        video.onerror = () => {
            cleanup();
            reject(new Error('Failed to read video metadata.'));
        };

        video.src = url;
    });

export const getCodecStringForResolution = (width: number, height: number) =>
    width >= FOUR_K_WIDTH || height >= FOUR_K_HEIGHT ? AVC_LEVEL_5_1 : AVC_LEVEL_4_0;

export const estimateBitrateForResolution = (width: number, height: number) => {
    const pixels = width * height;
    if (pixels >= FOUR_K_WIDTH * FOUR_K_HEIGHT) {
        return 25_000_000;
    }
    if (pixels >= 2560 * 1440) {
        return 16_000_000;
    }
    if (pixels >= 1920 * 1080) {
        return 12_000_000;
    }
    if (pixels >= 1280 * 720) {
        return 6_000_000;
    }
    return 3_000_000;
};

export const formatResolutionLabel = (width?: number, height?: number) =>
    width && height ? `${width}x${height}` : 'this resolution';

export const runPreflightChecks = (segments: TransitionVideo[]): PreflightWarning[] => {
    const warnings: PreflightWarning[] = [];

    // 1. Check for mixed orientation
    let hasPortrait = false;
    let hasLandscape = false;
    segments.forEach((s) => {
        if (s.width && s.height) {
            if (s.height > s.width) hasPortrait = true;
            else hasLandscape = true;
        }
    });

    if (hasPortrait && hasLandscape) {
        warnings.push({
            id: 'orientation-mismatch',
            title: 'Mixed Video Orientations',
            description: 'You have both portrait and landscape videos. The final output might look rotated or stretched.',
            severity: 'warning',
        });
    }

    // 2. Check for large resolution disparity
    let minHeight = Infinity;
    let maxHeight = 0;
    segments.forEach((s) => {
        if (s.height) {
            minHeight = Math.min(minHeight, s.height);
            maxHeight = Math.max(maxHeight, s.height);
        }
    });

    if (maxHeight > 0 && minHeight < Infinity && maxHeight > minHeight * 2) {
        warnings.push({
            id: 'resolution-disparity',
            title: 'Resolution Disparity',
            description: `Some videos are much larger than others (Max: ${maxHeight}p, Min: ${minHeight}p). Smaller videos will be upscaled, which may look blurry.`,
            severity: 'warning',
        });
    }

    // 3. Check for mixed aspect ratios
    const validVideos = segments
        .filter((s) => s.width && s.height)
        .map((s) => ({ width: s.width!, height: s.height! }));

    if (validVideos.length > 1) {
        const consistency = calculateAspectRatioConsistency(validVideos);
        if (consistency < 100) {
            warnings.push({
                id: 'aspect-ratio-mismatch',
                title: 'Mixed Aspect Ratios',
                description: "Look, you've actually put the wrong file types in. But don't worry about it, we're going to encode it for you so you get a rough idea of what this looks like. But it might give an idea to go back and fix that so that it's consistent.",
                severity: 'warning',
            });
        }
    }

    // 4. Check total file size
    const totalSize = segments.reduce((acc, s) => acc + (s.file?.size || 0), 0);
    if (totalSize > MAX_TOTAL_SIZE_BYTES) {
        warnings.push({
            id: 'large-files',
            title: 'Large Project Size',
            description: `Total video size is ${(totalSize / (1024 * 1024 * 1024)).toFixed(1)}GB. This might crash the browser during processing.`,
            severity: 'error', // High risk
        });
    }

    // 4. Encoder support (re-using existing status)
    const unsupportedVideos = segments.filter(s => s.encodeCapability?.status === 'unsupported');
    if (unsupportedVideos.length > 0) {
        warnings.push({
            id: 'unsupported-encoder',
            title: 'Unsupported Resolution',
            description: `Your device cannot encode some video resolutions (e.g. ${unsupportedVideos[0].width}x${unsupportedVideos[0].height}). The process will likely fail.`,
            severity: 'error',
        });
    }

    return warnings;
};
