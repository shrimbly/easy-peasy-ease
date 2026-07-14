'use client';

import { useState, useCallback } from 'react';
import { useApplySpeedCurve } from './useApplySpeedCurve';
import { useStitchVideos } from './useStitchVideos';
import { useAudioMixing } from './useAudioMixing';
import { useRemuxAudio } from './useRemuxAudio';
import {
  TransitionVideo,
  FinalizeContext,
  FinalizeResult,
  SpeedCurvedBlobCache,
  RenderQuality,
} from '@/lib/types';
import { DEFAULT_OUTPUT_DURATION, DEFAULT_EASING } from '@/lib/speed-curve-config';
import { createBezierEasing, resolveEasing, type EasingFunction } from '@/lib/easing-functions';
import { isAbortError } from '@/lib/abort-utils';

export interface FinalizeProgress {
  stage: 'idle' | 'applying-curves' | 'mixing-audio' | 'stitching' | 'remuxing' | 'complete' | 'error';
  message: string;
  progress: number; // 0-100
  currentVideo?: number;
  totalVideos?: number;
  error?: string;
  /** Non-fatal problems the user should know about (e.g. rendered without audio) */
  warnings?: string[];
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
 * Compute a hash string for cache invalidation based on every parameter that
 * affects speed-curve output — including render quality and input duration,
 * so preview-quality intermediates can never silently end up inside a
 * full-quality export.
 */
export function computeConfigHash(
  videos: TransitionVideo[],
  quality: RenderQuality,
  inputDuration: number
): string {
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
      // Split-mode source range — moving a split must invalidate the cache.
      sourceStart: v.sourceStartTime ?? null,
      sourceEnd: v.sourceEndTime ?? null,
    }));
  return JSON.stringify({ quality, inputDuration, segments: relevantData });
}

/**
 * Hook that orchestrates the complete finalization pipeline with multiple paths:
 * - Fast path: remux audio only (when only fade/offset settings change)
 * - Medium path: re-stitch with cached blobs (when audio file changes)
 * - Full path: apply speed curves and stitch (when segment params change)
 *
 * Fast and medium paths are only taken when the cached blobs were produced
 * from the exact current configuration (validated via configHash).
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
      const quality: RenderQuality = context.quality ?? 'full';
      const signal = context.signal;
      const warnings: string[] = [];

      const emit = (p: Omit<FinalizeProgress, 'warnings'>) => {
        const withWarnings: FinalizeProgress = warnings.length ? { ...p, warnings: [...warnings] } : p;
        setProgress(withWarnings);
        onProgress?.(withWarnings);
      };

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
        const currentConfigHash = computeConfigHash(transitionVideos, quality, inputDuration);

        // Cached intermediates may only be reused when they were rendered
        // from the exact current segment configuration and quality.
        const cacheIsValid =
          !!context.cachedBlobs &&
          context.cachedBlobs.configHash === currentConfigHash &&
          context.cachedBlobs.blobs.size >= totalVideos &&
          videosWithUrls.every((v) => context.cachedBlobs!.blobs.has(v.id));

        // ===========================================
        // FAST PATH: Remux audio only (fade changes)
        // ===========================================
        if (
          context.reason === 'audio-fade' &&
          context.previousFinalVideo &&
          context.audioBlob &&
          context.audioSettings &&
          cacheIsValid
        ) {
          emit({
            stage: 'remuxing',
            message: 'Applying audio changes...',
            progress: 0,
            totalVideos,
          });

          try {
            const remuxedBlob = await remuxWithNewAudio(
              context.previousFinalVideo,
              context.audioBlob,
              context.audioSettings,
              {
                quality,
                signal,
                onProgress: (p) => {
                  emit({
                    stage: 'remuxing',
                    message: p.message,
                    progress: p.progress,
                    totalVideos,
                  });
                },
              }
            );

            if (!remuxedBlob) {
              throw new Error('Remux failed');
            }

            emit({
              stage: 'complete',
              message: `Success! Created ${(remuxedBlob.size / 1024 / 1024).toFixed(2)}MB final video`,
              progress: 100,
              totalVideos,
            });

            return {
              finalBlob: remuxedBlob,
              speedCurvedCache: context.cachedBlobs!, // Preserve existing cache
            };
          } catch (remuxError) {
            if (isAbortError(remuxError)) throw remuxError;
            // Fall back to medium path if remux fails
            console.warn('Remux failed, falling back to re-stitch:', remuxError);
          }
        }

        // ===========================================
        // MEDIUM PATH: Use cached blobs, re-stitch
        // ===========================================
        if (
          (context.reason === 'audio-file' || context.reason === 'audio-fade') &&
          cacheIsValid
        ) {
          emit({
            stage: 'stitching',
            message: 'Stitching videos...',
            progress: 0,
            totalVideos,
          });

          const speedCurvedBlobs = videosWithUrls.map(
            (video) => context.cachedBlobs!.blobs.get(video.id)!
          );

          // Prepare audio if provided
          let audioData: { buffer: AudioBuffer; duration: number } | undefined;
          const totalVideoDuration = videosWithUrls.reduce(
            (sum, v) => sum + (v.duration ?? DEFAULT_OUTPUT_DURATION),
            0
          );

          if (context.audioBlob) {
            emit({
              stage: 'mixing-audio',
              message: 'Preparing audio track...',
              progress: 25,
              totalVideos,
            });

            try {
              audioData = await prepareAudio(
                context.audioBlob,
                totalVideoDuration,
                (mixProgress) => {
                  emit({
                    stage: 'mixing-audio',
                    message: mixProgress.message,
                    progress: 25 + (mixProgress.progress / 100) * 25,
                    totalVideos,
                  });
                },
                context.audioSettings
              ) ?? undefined;
            } catch (audioError) {
              if (isAbortError(audioError)) throw audioError;
              console.warn('Audio processing error, continuing without audio:', audioError);
              warnings.push(
                'Your music could not be processed, so the video was rendered without audio.'
              );
            }
          }

          const finalBlob = await stitchVideos(speedCurvedBlobs, {
            quality,
            signal,
            audioData,
            onWarning: (message) => warnings.push(message),
            onProgress: (stitchProg) => {
              const baseProgress = audioData ? 50 : 25;
              const rangeProgress = audioData ? 50 : 75;
              emit({
                stage: 'stitching',
                message: stitchProg.message,
                progress: baseProgress + (stitchProg.progress / 100) * rangeProgress,
                currentVideo: stitchProg.currentVideo,
                totalVideos: stitchProg.totalVideos,
              });
            },
          });

          if (!finalBlob) {
            throw new Error('Failed to stitch videos');
          }

          emit({
            stage: 'complete',
            message: `Success! Created ${(finalBlob.size / 1024 / 1024).toFixed(2)}MB final video`,
            progress: 100,
            totalVideos,
          });

          return {
            finalBlob,
            speedCurvedCache: context.cachedBlobs!, // Preserve existing cache
          };
        }

        // ===========================================
        // FULL PATH: Apply speed curves and stitch
        // ===========================================
        const transitionMap = new Map(transitionVideos.map((segment) => [segment.id, segment]));

        emit({
          stage: 'applying-curves',
          message: 'Applying speed curves...',
          progress: 0,
          totalVideos,
        });

        // Step 1: Apply speed curves to each video
        const speedCurvedBlobs: Blob[] = [];
        const newCacheBlobs = new Map<number, Blob>();

        for (let i = 0; i < videosWithUrls.length; i++) {
          const video = videosWithUrls[i];
          const videoNumber = i + 1;
          const segmentMetadata = transitionMap.get(video.id) ?? video;
          const targetDuration = segmentMetadata.duration ?? DEFAULT_OUTPUT_DURATION;
          let easingFunction: EasingFunction;

          if (segmentMetadata.useCustomEasing && segmentMetadata.customBezier) {
            easingFunction = createBezierEasing(...segmentMetadata.customBezier);
          } else {
            // Presets are cubic-beziers; resolveEasing turns the name into a
            // bezier evaluator (legacy math-function names still work too).
            easingFunction = resolveEasing(segmentMetadata.easingPreset ?? DEFAULT_EASING);
          }

          // Resolve a readable source blob: prefer the original File (backed
          // by disk, no RAM copy), then any cached blob, then object-URL fetch.
          const verifyBlob = async (b: Blob) => {
            try {
              await b.slice(0, 1024).arrayBuffer();
              return true;
            } catch {
              return false;
            }
          };

          let videoBlob: Blob | null = null;
          for (const candidate of [segmentMetadata.file, segmentMetadata.cachedBlob]) {
            if (candidate && (await verifyBlob(candidate))) {
              videoBlob = candidate;
              break;
            }
          }
          if (!videoBlob) {
            console.warn(`No readable blob for video ${videoNumber}, falling back to fetch`);
            const response = await fetch(video.url);
            if (!response.ok) {
              throw new Error(`Failed to fetch video: ${response.statusText}`);
            }
            videoBlob = await response.blob();
          }

          const updateMsg = `Applying speed curve to video ${videoNumber}/${totalVideos}...`;
          emit({
            stage: 'applying-curves',
            message: updateMsg,
            progress: (i / totalVideos) * 50,
            currentVideo: videoNumber,
            totalVideos,
          });

          const curvedBlob = await applySpeedCurve(videoBlob, {
            inputDuration,
            outputDuration: targetDuration,
            easing: easingFunction,
            quality,
            signal,
            // Split-mode: retime only this section's sub-range of the source.
            sourceStartTime: segmentMetadata.sourceStartTime,
            sourceEndTime: segmentMetadata.sourceEndTime,
            onProgress: (curveProgress) => {
              emit({
                stage: 'applying-curves',
                message: `${updateMsg} (${curveProgress.message})`,
                progress: (i / totalVideos) * 50 + (curveProgress.progress / 100) * (50 / totalVideos),
                currentVideo: videoNumber,
                totalVideos,
              });
            },
          });

          if (!curvedBlob) {
            if (signal?.aborted) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            throw new Error(`Failed to apply speed curve to video ${videoNumber}`);
          }

          speedCurvedBlobs.push(curvedBlob);
          newCacheBlobs.set(video.id, curvedBlob);
        }

        // Step 2: Prepare audio if provided
        let audioData: { buffer: AudioBuffer; duration: number } | undefined;
        const totalVideoDuration = videosWithUrls.reduce(
          (sum, v) => sum + (v.duration ?? DEFAULT_OUTPUT_DURATION),
          0
        );

        if (context.audioBlob) {
          emit({
            stage: 'mixing-audio',
            message: 'Preparing audio track...',
            progress: 50,
            totalVideos,
          });

          try {
            audioData = await prepareAudio(
              context.audioBlob,
              totalVideoDuration,
              (mixProgress) => {
                emit({
                  stage: 'mixing-audio',
                  message: mixProgress.message,
                  progress: 50 + (mixProgress.progress / 100) * 25,
                  totalVideos,
                });
              },
              context.audioSettings
            ) ?? undefined;
          } catch (audioError) {
            if (isAbortError(audioError)) throw audioError;
            console.warn('Audio processing error, continuing without audio:', audioError);
            warnings.push(
              'Your music could not be processed, so the video was rendered without audio.'
            );
          }
        }

        // Step 3: Stitch all speed-curved videos together with audio
        emit({
          stage: 'stitching',
          message: 'Stitching videos together...',
          progress: audioData ? 75 : 50,
          totalVideos,
        });

        const finalBlob = await stitchVideos(speedCurvedBlobs, {
          quality,
          signal,
          audioData,
          onWarning: (message) => warnings.push(message),
          onProgress: (stitchProgress) => {
            const baseProgress = audioData ? 75 : 50;
            const rangeProgress = audioData ? 25 : 50;
            emit({
              stage: 'stitching',
              message: stitchProgress.message,
              progress: baseProgress + (stitchProgress.progress / 100) * rangeProgress,
              currentVideo: stitchProgress.currentVideo,
              totalVideos: stitchProgress.totalVideos,
            });
          },
        });

        if (!finalBlob) {
          throw new Error('Failed to stitch videos');
        }

        // Build cache for future updates
        const newCache: SpeedCurvedBlobCache = {
          blobs: newCacheBlobs,
          configHash: currentConfigHash,
        };

        emit({
          stage: 'complete',
          message: `Success! Created ${(finalBlob.size / 1024 / 1024).toFixed(2)}MB final video`,
          progress: 100,
          totalVideos,
        });

        return {
          finalBlob,
          speedCurvedCache: newCache,
        };
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          emit({
            stage: 'idle',
            message: 'Cancelled',
            progress: 0,
          });
          return null;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Video finalization error:', error);

        emit({
          stage: 'error',
          message: `Error: ${errorMessage}`,
          progress: 0,
          error: errorMessage,
        });

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
