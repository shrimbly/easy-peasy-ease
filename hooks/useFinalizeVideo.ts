'use client';

import { useState, useCallback } from 'react';
import { useApplySpeedCurve } from './useApplySpeedCurve';
import { useStitchVideos } from './useStitchVideos';
import { useAudioMixing } from './useAudioMixing';
import { useRemuxAudio } from './useRemuxAudio';
import {
  TransitionVideo,
  AudioProcessingOptions,
  FinalizeContext,
  FinalizeResult,
  SpeedCurvedBlobCache,
  RenderQuality,
} from '@/lib/types';
import { DEFAULT_OUTPUT_DURATION, DEFAULT_EASING } from '@/lib/speed-curve-config';
import { createBezierEasing, type EasingFunction } from '@/lib/easing-functions';

interface FinalizeProgress {
  stage: 'idle' | 'applying-curves' | 'mixing-audio' | 'stitching' | 'remuxing' | 'complete' | 'error';
  message: string;
  progress: number; // 0-100
  currentVideo?: number;
  totalVideos?: number;
  error?: string;
}

interface UseFinalizeVideoReturn {
  finalizeVideos: (
    transitionVideos: TransitionVideo[],
    context: FinalizeContext,
    onProgress?: (progress: FinalizeProgress) => void,
    inputDuration?: number
  ) => Promise<FinalizeResult | null>;
  progress: FinalizeProgress;
  reset: () => void;
}

/**
 * Compute a hash string for cache invalidation based on segment parameters
 * that affect speed curve output.
 */
function computeConfigHash(videos: TransitionVideo[]): string {
  const relevantData = videos
    .filter((v) => v.url && !v.loading)
    .map((v) => ({
      id: v.id,
      duration: v.duration ?? DEFAULT_OUTPUT_DURATION,
      easingPreset: v.easingPreset ?? DEFAULT_EASING,
      useCustomEasing: v.useCustomEasing ?? false,
      customBezier: v.customBezier?.join(',') ?? '',
      // Use file size as proxy for source video identity
      sourceSize: v.file?.size ?? v.cachedBlob?.size ?? 0,
    }));
  return JSON.stringify(relevantData);
}

/**
 * Hook that orchestrates the complete finalization pipeline with multiple paths:
 * - Fast path: remux audio only (when only fade settings change)
 * - Medium path: re-stitch with cached blobs (when audio file changes)
 * - Full path: apply speed curves and stitch (when segment params change)
 */
export const useFinalizeVideo = (): UseFinalizeVideoReturn => {
  const [progress, setProgress] = useState<FinalizeProgress>({
    stage: 'idle',
    message: 'Ready to finalize',
    progress: 0,
  });

  const { applySpeedCurve } = useApplySpeedCurve();
  const { stitchVideos } = useStitchVideos();
  const { prepareAudio } = useAudioMixing();
  const { remuxWithNewAudio } = useRemuxAudio();

  const finalizeVideos = useCallback(
    async (
      transitionVideos: TransitionVideo[],
      context: FinalizeContext,
      onProgress?: (progress: FinalizeProgress) => void,
      inputDuration: number = 5
    ): Promise<FinalizeResult | null> => {
      // Extract quality from context, default to 'full'
      const quality: RenderQuality = context.quality ?? 'full';
      try {
        // Validate inputs
        if (transitionVideos.length === 0) {
          throw new Error('No videos to finalize');
        }

        const videosWithUrls = transitionVideos.filter((v) => v.url && !v.loading);
        if (videosWithUrls.length === 0) {
          throw new Error('No successfully loaded videos');
        }

        const totalVideos = videosWithUrls.length;

        // ===========================================
        // FAST PATH: Remux audio only (fade changes)
        // ===========================================
        if (
          context.reason === 'audio-fade' &&
          context.previousFinalVideo &&
          context.audioBlob &&
          context.audioSettings &&
          context.cachedBlobs
        ) {
          const remuxProgress: FinalizeProgress = {
            stage: 'remuxing',
            message: 'Applying audio changes...',
            progress: 0,
            totalVideos,
          };
          setProgress(remuxProgress);
          onProgress?.(remuxProgress);

          try {
            const remuxedBlob = await remuxWithNewAudio(
              context.previousFinalVideo,
              context.audioBlob,
              context.audioSettings,
              (p) => {
                const progressUpdate: FinalizeProgress = {
                  stage: 'remuxing',
                  message: p.message,
                  progress: p.progress,
                  totalVideos,
                };
                setProgress(progressUpdate);
                onProgress?.(progressUpdate);
              }
            );

            if (!remuxedBlob) {
              throw new Error('Remux failed');
            }

            const completeProgress: FinalizeProgress = {
              stage: 'complete',
              message: `Success! Created ${(remuxedBlob.size / 1024 / 1024).toFixed(2)}MB final video`,
              progress: 100,
              totalVideos,
            };
            setProgress(completeProgress);
            onProgress?.(completeProgress);

            return {
              finalBlob: remuxedBlob,
              speedCurvedCache: context.cachedBlobs, // Preserve existing cache
            };
          } catch (remuxError) {
            // Fall back to medium path if remux fails
            console.warn('Remux failed, falling back to re-stitch:', remuxError);
            // Continue to medium path below
          }
        }

        // ===========================================
        // MEDIUM PATH: Use cached blobs, re-stitch
        // ===========================================
        if (
          (context.reason === 'audio-file' || context.reason === 'audio-fade') &&
          context.cachedBlobs &&
          context.cachedBlobs.blobs.size >= totalVideos
        ) {
          const stitchStartProgress: FinalizeProgress = {
            stage: 'stitching',
            message: 'Stitching videos...',
            progress: 0,
            totalVideos,
          };
          setProgress(stitchStartProgress);
          onProgress?.(stitchStartProgress);

          // Get cached blobs in order
          const speedCurvedBlobs: Blob[] = [];
          for (const video of videosWithUrls) {
            const cachedBlob = context.cachedBlobs.blobs.get(video.id);
            if (cachedBlob) {
              speedCurvedBlobs.push(cachedBlob);
            } else {
              // Cache miss - fall through to full path
              console.warn(`Cache miss for video ${video.id}, falling back to full render`);
              break;
            }
          }

          // Only use medium path if we have all cached blobs
          if (speedCurvedBlobs.length === totalVideos) {
            // Prepare audio if provided
            let audioData: { buffer: AudioBuffer; duration: number } | undefined;
            const totalVideoDuration = videosWithUrls.reduce(
              (sum, v) => sum + (v.duration ?? DEFAULT_OUTPUT_DURATION),
              0
            );

            if (context.audioBlob) {
              const audioMixProgress: FinalizeProgress = {
                stage: 'mixing-audio',
                message: 'Preparing audio track...',
                progress: 25,
                totalVideos,
              };
              setProgress(audioMixProgress);
              onProgress?.(audioMixProgress);

              try {
                audioData = await prepareAudio(
                  context.audioBlob,
                  totalVideoDuration,
                  (mixProgress) => {
                    const overallProgress = 25 + (mixProgress.progress / 100) * 25;
                    const progressUpdate: FinalizeProgress = {
                      stage: 'mixing-audio',
                      message: mixProgress.message,
                      progress: overallProgress,
                      totalVideos,
                    };
                    setProgress(progressUpdate);
                    onProgress?.(progressUpdate);
                  },
                  context.audioSettings
                ) ?? undefined;
              } catch (audioError) {
                console.warn('Audio processing error, continuing without audio:', audioError);
              }
            }

            // Stitch videos
            const stitchProgress: FinalizeProgress = {
              stage: 'stitching',
              message: 'Stitching videos...',
              progress: audioData ? 50 : 25,
              totalVideos,
            };
            setProgress(stitchProgress);
            onProgress?.(stitchProgress);

            const finalBlob = await stitchVideos(
              speedCurvedBlobs,
              (stitchProg) => {
                const baseProgress = audioData ? 50 : 25;
                const rangeProgress = audioData ? 50 : 75;
                const overallProgress = baseProgress + (stitchProg.progress / 100) * rangeProgress;
                const progressUpdate: FinalizeProgress = {
                  stage: 'stitching',
                  message: stitchProg.message,
                  progress: overallProgress,
                  currentVideo: stitchProg.currentVideo,
                  totalVideos: stitchProg.totalVideos,
                };
                setProgress(progressUpdate);
                onProgress?.(progressUpdate);
              },
              undefined,
              audioData
            );

            if (!finalBlob) {
              throw new Error('Failed to stitch videos');
            }

            const completeProgress: FinalizeProgress = {
              stage: 'complete',
              message: `Success! Created ${(finalBlob.size / 1024 / 1024).toFixed(2)}MB final video`,
              progress: 100,
              totalVideos,
            };
            setProgress(completeProgress);
            onProgress?.(completeProgress);

            return {
              finalBlob,
              speedCurvedCache: context.cachedBlobs, // Preserve existing cache
            };
          }
        }

        // ===========================================
        // FULL PATH: Apply speed curves and stitch
        // ===========================================
        const transitionMap = new Map(transitionVideos.map((segment) => [segment.id, segment]));

        // Reset progress
        const initialProgress: FinalizeProgress = {
          stage: 'applying-curves',
          message: 'Applying speed curves...',
          progress: 0,
          totalVideos,
        };
        setProgress(initialProgress);
        onProgress?.(initialProgress);

        // Step 1: Apply speed curves to each video
        const speedCurvedBlobs: Blob[] = [];
        const newCacheBlobs = new Map<number, Blob>();

        for (let i = 0; i < videosWithUrls.length; i++) {
          const video = videosWithUrls[i];
          const videoNumber = i + 1;
          const segmentMetadata = transitionMap.get(video.id) ?? video;
          const targetDuration = segmentMetadata.duration ?? DEFAULT_OUTPUT_DURATION;
          let easingFunction: EasingFunction | string = DEFAULT_EASING;

          if (segmentMetadata.useCustomEasing && segmentMetadata.customBezier) {
            easingFunction = createBezierEasing(...segmentMetadata.customBezier);
          } else if (segmentMetadata.easingPreset) {
            easingFunction = segmentMetadata.easingPreset;
          }

          try {
            // Fetch video blob from URL or use cached file
            let videoBlob: Blob;

            console.log(`[Debug] Processing video ${videoNumber}`, {
              id: video.id,
              hasFile: !!segmentMetadata.file,
              hasCachedBlob: !!segmentMetadata.cachedBlob,
              fileName: segmentMetadata.file instanceof File ? segmentMetadata.file.name : 'not-a-file',
              fileSize: segmentMetadata.file?.size,
              url: video.url
            });

            // Helper to verify blob is readable
            const verifyBlob = async (b: Blob, label: string) => {
              try {
                const slice = b.slice(0, 1024);
                await slice.arrayBuffer();
                console.log(`[Debug] ${label} is readable`);
                return true;
              } catch (e) {
                console.error(`[Debug] ${label} is NOT readable`, e);
                return false;
              }
            };

            const tryGetReadableBlob = async (): Promise<Blob | null> => {
              const candidates: Array<{ blob?: Blob; label: string }> = [
                { blob: segmentMetadata.cachedBlob, label: 'Cached blob' },
                { blob: segmentMetadata.file, label: 'File' },
              ];
              for (const candidate of candidates) {
                if (!candidate.blob) continue;
                const readable = await verifyBlob(candidate.blob, candidate.label);
                if (readable) {
                  return candidate.blob;
                }
              }
              return null;
            };

            const readableSource = await tryGetReadableBlob();

            if (readableSource) {
              videoBlob = readableSource;
            } else {
              console.warn(`[Debug] No readable blob for video ${videoNumber}, falling back to fetch`);
              const response = await fetch(video.url);
              if (!response.ok) {
                throw new Error(`Failed to fetch video: ${response.statusText}`);
              }
              videoBlob = await response.blob();
            }

            // Update progress
            const curveProgress = ((i) / totalVideos) * 50;
            const updateMsg = `Applying speed curve to video ${videoNumber}/${totalVideos}...`;
            const progressObj: FinalizeProgress = {
              stage: 'applying-curves',
              message: updateMsg,
              progress: curveProgress,
              currentVideo: videoNumber,
              totalVideos,
            };
            setProgress(progressObj);
            onProgress?.(progressObj);

            // Apply speed curve with progress callback
            const curvedBlob = await applySpeedCurve(
              videoBlob,
              inputDuration, // Input duration from settings
              targetDuration,
              (curveProgress_inner) => {
                const overallProgress = (i / totalVideos) * 50 +
                  (curveProgress_inner.progress / 100) * (50 / totalVideos);
                const progressUpdate: FinalizeProgress = {
                  stage: 'applying-curves',
                  message: `${updateMsg} (${curveProgress_inner.message})`,
                  progress: overallProgress,
                  currentVideo: videoNumber,
                  totalVideos,
                };
                setProgress(progressUpdate);
                onProgress?.(progressUpdate);
              },
              easingFunction,
              undefined, // bitrate (let hook determine based on quality)
              quality
            );

            if (!curvedBlob) {
              throw new Error(`Failed to apply speed curve to video ${videoNumber}`);
            }

            speedCurvedBlobs.push(curvedBlob);
            newCacheBlobs.set(video.id, curvedBlob);
          } catch (error) {
            const errorMsg = error instanceof Error
              ? error.message
              : `Failed to process video ${videoNumber}`;
            console.error(`Error processing video ${videoNumber}:`, error);
            throw new Error(errorMsg);
          }
        }

        // Step 2: Prepare audio if provided
        let audioData: { buffer: AudioBuffer; duration: number } | undefined;
        let totalVideoDuration = 0;

        // Calculate total video duration
        if (speedCurvedBlobs.length > 0) {
          totalVideoDuration = transitionVideos
            .filter((v) => v.url && !v.loading)
            .reduce((sum, v) => sum + (v.duration ?? DEFAULT_OUTPUT_DURATION), 0);
        }

        if (context.audioBlob) {
          const audioMixProgress: FinalizeProgress = {
            stage: 'mixing-audio',
            message: 'Preparing audio track...',
            progress: 50,
            totalVideos,
          };
          setProgress(audioMixProgress);
          onProgress?.(audioMixProgress);

          try {
            audioData = await prepareAudio(
              context.audioBlob,
              totalVideoDuration,
              (mixProgress) => {
                const overallProgress = 50 + (mixProgress.progress / 100) * 25;
                const progressUpdate: FinalizeProgress = {
                  stage: 'mixing-audio',
                  message: mixProgress.message,
                  progress: overallProgress,
                  totalVideos,
                };
                setProgress(progressUpdate);
                onProgress?.(progressUpdate);
              },
              context.audioSettings
            ) ?? undefined;
          } catch (audioError) {
            const errorMsg = audioError instanceof Error ? audioError.message : 'Failed to process audio';
            console.warn('Audio processing error, continuing without audio:', audioError);
          }
        }

        // Step 3: Stitch all speed-curved videos together with audio
        const stitchStartProgress: FinalizeProgress = {
          stage: 'stitching',
          message: 'Stitching videos together...',
          progress: audioData ? 75 : 50,
          totalVideos,
        };
        setProgress(stitchStartProgress);
        onProgress?.(stitchStartProgress);

        const finalBlob = await stitchVideos(
          speedCurvedBlobs,
          (stitchProgress) => {
            const baseProgress = audioData ? 75 : 50;
            const rangeProgress = audioData ? 25 : 50;
            const overallProgress = baseProgress + (stitchProgress.progress / 100) * rangeProgress;
            const progressUpdate: FinalizeProgress = {
              stage: 'stitching',
              message: stitchProgress.message,
              progress: overallProgress,
              currentVideo: stitchProgress.currentVideo,
              totalVideos: stitchProgress.totalVideos,
            };
            setProgress(progressUpdate);
            onProgress?.(progressUpdate);
          },
          undefined, // Use default bitrate
          audioData,
          quality
        );

        if (!finalBlob) {
          throw new Error('Failed to stitch videos');
        }

        // Build cache for future updates
        const newCache: SpeedCurvedBlobCache = {
          blobs: newCacheBlobs,
          configHash: computeConfigHash(transitionVideos),
        };

        const completeProgress: FinalizeProgress = {
          stage: 'complete',
          message: `Success! Created ${(finalBlob.size / 1024 / 1024).toFixed(2)}MB final video`,
          progress: 100,
          totalVideos,
        };
        setProgress(completeProgress);
        onProgress?.(completeProgress);

        return {
          finalBlob,
          speedCurvedCache: newCache,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Video finalization error:', error);

        const errorProgress: FinalizeProgress = {
          stage: 'error',
          message: `Error: ${errorMessage}`,
          progress: 0,
          error: errorMessage,
        };

        setProgress(errorProgress);
        onProgress?.(errorProgress);

        return null;
      }
    },
    [applySpeedCurve, stitchVideos, prepareAudio, remuxWithNewAudio]
  );

  const reset = useCallback(() => {
    setProgress({
      stage: 'idle',
      message: 'Ready to finalize',
      progress: 0,
    });
  }, []);

  return {
    finalizeVideos,
    progress,
    reset,
  };
};
