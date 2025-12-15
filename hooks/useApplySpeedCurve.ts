'use client';

import { useState, useCallback } from 'react';
import {
  Input,
  Output,
  VideoSampleSink,
  VideoSampleSource,
  BlobSource,
  ALL_FORMATS,
  BufferTarget,
  Mp4OutputFormat,
  canEncodeVideo,
} from 'mediabunny';
import type { Rotation } from 'mediabunny';
import {
  selectAdaptiveEasing,
  type VideoCurveMetadata,
} from '@/lib/speed-curve';
import { getEasingFunction, type EasingFunction } from '@/lib/easing-functions';
import {
  DEFAULT_BITRATE,
  TARGET_FRAME_RATE,
  DEFAULT_INPUT_DURATION,
  DEFAULT_OUTPUT_DURATION,
  DEFAULT_EASING,
  MAX_OUTPUT_FPS,
} from '@/lib/speed-curve-config';
import { createAvcEncodingConfig, AVC_LEVEL_4_0, AVC_LEVEL_5_1 } from '@/lib/video-encoding';

type VideoSampleLike = Parameters<VideoSampleSource['add']>[0];

interface SpeedCurveProgress {
  status: 'idle' | 'processing' | 'complete' | 'error';
  message: string;
  progress: number; // 0-100
  error?: string;
}

interface UseApplySpeedCurveReturn {
  applySpeedCurve: (
    videoBlob: Blob,
    inputDuration?: number,
    outputDuration?: number,
    onProgress?: (progress: SpeedCurveProgress) => void,
    easingFunction?: EasingFunction | string,
    bitrate?: number
  ) => Promise<Blob | null>;
  progress: SpeedCurveProgress;
  reset: () => void;
}

// Helper to get video dimensions
const getVideoDimensions = (blob: Blob): Promise<{ width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
      URL.revokeObjectURL(video.src);
    };
    video.onerror = () => {
      reject(new Error('Failed to load video metadata'));
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(blob);
  });
};

const normalizeRotation = (value: unknown): Rotation => {
  return value === 0 || value === 90 || value === 180 || value === 270 ? value : 0;
};

/**
 * Hook for applying speed curves to video using Mediabunny
 * Uses an expo-in / cubic-out hybrid by default for 1.5s output duration
 */
export const useApplySpeedCurve = (): UseApplySpeedCurveReturn => {
  const [progress, setProgress] = useState<SpeedCurveProgress>({
    status: 'idle',
    message: 'Ready',
    progress: 0,
  });

  const applySpeedCurve = useCallback(
    async (
      videoBlob: Blob,
      inputDuration: number = DEFAULT_INPUT_DURATION,
      outputDuration: number = DEFAULT_OUTPUT_DURATION,
      onProgress?: (progress: SpeedCurveProgress) => void,
      easingFunction: EasingFunction | string = DEFAULT_EASING,
      bitrate: number = DEFAULT_BITRATE
    ): Promise<Blob | null> => {
      let input: Input | null = null;

      try {
        // Reset progress
        const initialProgress: SpeedCurveProgress = {
          status: 'processing',
          message: 'Initializing...',
          progress: 0,
        };
        setProgress(initialProgress);
        onProgress?.(initialProgress);

        // Helper to update progress
        const updateProgress = (
          status: SpeedCurveProgress['status'],
          message: string,
          progressValue: number
        ) => {
          const p: SpeedCurveProgress = { status, message, progress: progressValue };
          setProgress(p);
          onProgress?.(p);
        };

        updateProgress('processing', 'Creating input from video blob...', 5);

        // Step 1: Create input from blob
        const blobSource = new BlobSource(videoBlob);
        input = new Input({
          source: blobSource,
          formats: ALL_FORMATS,
        });
        const videoTracks = await input.getVideoTracks();

        if (videoTracks.length === 0) {
          throw new Error('No video tracks found in input');
        }

        const videoTrack = videoTracks[0];
        const trackRotation = normalizeRotation(
          typeof videoTrack.rotation === 'number' ? videoTrack.rotation : undefined
        );

        // Step 2: Analyze metadata up front so we can adapt easing to the source
        // NOTE: We delay creating the VideoSampleSink until after all preliminary scanning
        // to avoid resource contention with parallel Input instances
        updateProgress('processing', 'Analyzing video metadata...', 10);

        const [trackDuration, containerDuration, packetStats, dimensions] = await Promise.all([
          videoTrack.computeDuration().catch(() => null),
          input.computeDuration().catch(() => null),
          videoTrack
            .computePacketStats()
            .catch((statsError) => {
              console.warn('Failed to compute packet stats', statsError);
              return null;
            }),
          getVideoDimensions(videoBlob).catch((e) => {
            console.warn('Failed to get video dimensions', e);
            return { width: 1920, height: 1080 }; // Fallback
          })
        ]);

        let resolvedBitrate = Number.isFinite(bitrate) ? bitrate : DEFAULT_BITRATE;
        if (packetStats?.averageBitrate && Number.isFinite(packetStats.averageBitrate)) {
          resolvedBitrate = Math.max(resolvedBitrate, packetStats.averageBitrate);
        }
        resolvedBitrate = Math.max(1, Math.floor(resolvedBitrate));

        const resolvedDuration =
          typeof trackDuration === 'number' && Number.isFinite(trackDuration) && trackDuration > 0
            ? trackDuration
            : typeof containerDuration === 'number' && Number.isFinite(containerDuration) && containerDuration > 0
              ? containerDuration
              : inputDuration;

        const frameRate =
          packetStats?.averagePacketRate && Number.isFinite(packetStats.averagePacketRate)
            ? packetStats.averagePacketRate
            : TARGET_FRAME_RATE;

        const metadata: VideoCurveMetadata = {
          duration: resolvedDuration,
          bitrate:
            packetStats?.averageBitrate && Number.isFinite(packetStats.averageBitrate)
              ? packetStats.averageBitrate
              : resolvedBitrate,
          frameRate,
        };

        const shouldAdaptCurve =
          typeof easingFunction === 'string' && easingFunction === DEFAULT_EASING;
        const adaptiveSelection = shouldAdaptCurve ? selectAdaptiveEasing(metadata) : null;
        const easingToUse: EasingFunction | string =
          adaptiveSelection?.easingFunction ?? easingFunction;

        const effectiveInputDuration =
          typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) && metadata.duration > 0
            ? metadata.duration
            : inputDuration;
            
        const fpsDisplay = metadata.frameRate.toFixed(1);
        const bitrateDisplay = (metadata.bitrate / 1_000_000).toFixed(1);
        const durationDisplay = effectiveInputDuration.toFixed(2);
        const metadataSummary = `${durationDisplay}s @ ${fpsDisplay}fps @ ${bitrateDisplay}Mbps`;

        updateProgress(
          'processing',
          adaptiveSelection
            ? `Metadata analyzed (${metadataSummary}) -> ${adaptiveSelection.easingName}`
            : `Metadata analyzed (${metadataSummary})`,
          18
        );

        // Step 3: Create output with video source
        updateProgress('processing', 'Configuring encoder...', 20);

        // Determine best supported resolution/bitrate
        const sourceWidth = dimensions.width;
        const sourceHeight = dimensions.height;
        // Always output at MAX_OUTPUT_FPS (60fps) for smooth easing, regardless of source fps
        // The output-driven emission will repeat/skip source frames as needed
        const targetFramerate = MAX_OUTPUT_FPS;

        type VideoTier = {
          width: number;
          height: number;
          bitrate: number;
          codec: string;
          label: string;
        };

        // Define fallback tiers - preserve source bitrate at each tier for quality
        const tiers: VideoTier[] = [
          // Tier 1: Original Resolution with High profile 5.1
          {
            width: sourceWidth,
            height: sourceHeight,
            bitrate: resolvedBitrate,
            codec: AVC_LEVEL_5_1,
            label: 'Original'
          },
          // Tier 2: 1080p with High profile 4.0 - preserve source bitrate
          {
            width: Math.min(sourceWidth, 1920),
            height: Math.min(sourceHeight, 1080),
            bitrate: resolvedBitrate, // No cap - preserve source quality
            codec: AVC_LEVEL_4_0,
            label: '1080p'
          },
          // Tier 3: 720p with High profile 4.0 - preserve source bitrate
          {
            width: Math.min(sourceWidth, 1280),
            height: Math.min(sourceHeight, 720),
            bitrate: resolvedBitrate, // No cap - preserve source quality
            codec: AVC_LEVEL_4_0,
            label: '720p'
          }
        ];

        let selectedConfig:
          | (VideoTier & { width: number; height: number; framerate: number })
          | null = null;

        for (const tier of tiers) {
          // Maintain aspect ratio if downscaling
          let targetWidth = tier.width;
          let targetHeight = tier.height;

          if (targetWidth < sourceWidth || targetHeight < sourceHeight) {
            const scale = Math.min(tier.width / sourceWidth, tier.height / sourceHeight);
            targetWidth = Math.round(sourceWidth * scale) & ~1; // Ensure even dimensions
            targetHeight = Math.round(sourceHeight * scale) & ~1;
          }

          const supported = await canEncodeVideo('avc', {
            width: targetWidth,
            height: targetHeight,
            bitrate: tier.bitrate,
            fullCodecString: tier.codec,
          });

          if (supported) {
            selectedConfig = {
              ...tier,
              width: targetWidth,
              height: targetHeight,
              framerate: targetFramerate,
            };
            break;
          }
        }

        if (!selectedConfig) {
          throw new Error(
            'Device encoder does not support the required H.264 profiles for this video. Try reducing resolution/bitrate and retry.'
          );
        }

        updateProgress(
          'processing',
          `Encoder selected: ${selectedConfig.label} (${selectedConfig.width}x${selectedConfig.height} @ ${selectedConfig.framerate}fps)`,
          22
        );

        const videoSource = new VideoSampleSource(
          createAvcEncodingConfig(
            selectedConfig.bitrate,
            selectedConfig.width,
            selectedConfig.height,
            selectedConfig.codec,
            selectedConfig.framerate
          )
        );

        const bufferTarget = new BufferTarget();
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target: bufferTarget,
        });

        output.addVideoTrack(videoSource, { rotation: trackRotation, frameRate: selectedConfig.framerate });

        updateProgress('processing', 'Starting output encoding...', 25);

        await output.start();

        // Step 4: OUTPUT-DRIVEN FRAME EMISSION
        // For each output frame, calculate which source timestamp to fetch using the easing function

        const minFrameInterval = 1 / selectedConfig.framerate;
        const totalOutputFrames = Math.floor(outputDuration * selectedConfig.framerate);

        // Resolve easing function once for efficiency
        const easingFunc = typeof easingToUse === 'string'
          ? getEasingFunction(easingToUse)
          : easingToUse;

        const emitSample = async (
          sourceSample: VideoSampleLike,
          timestamp: number,
          duration: number
        ) => {
          const outputSample = sourceSample.clone();
          outputSample.setTimestamp(timestamp);
          outputSample.setDuration(duration);
          await videoSource.add(outputSample);
          outputSample.close();
        };

        // OUTPUT-DRIVEN FRAME EMISSION using samplesAtTimestamps()
        // Instead of buffering all frames, we pre-calculate source timestamps and use
        // Mediabunny's optimized decoding pipeline for random access
        updateProgress('processing', 'Preparing frame decoder...', 25);
        const sink = new VideoSampleSink(videoTrack);

        // Pre-calculate all source timestamps we need based on easing function
        // For each output frame, determine which source timestamp to fetch
        const sourceTimestamps: number[] = [];
        const outputTimestamps: number[] = [];

        for (let outputSlot = 0; outputSlot < totalOutputFrames; outputSlot++) {
          const outputTime = outputSlot * minFrameInterval;
          const outputProgress = totalOutputFrames > 1
            ? outputSlot / (totalOutputFrames - 1)
            : 0;

          // Apply easing function: maps output progress to source progress
          const sourceProgress = easingFunc(outputProgress);

          // Map to source timestamp, clamped to valid range
          const sourceTime = Math.max(0, Math.min(
            sourceProgress * effectiveInputDuration,
            effectiveInputDuration - 0.001
          ));

          sourceTimestamps.push(sourceTime);
          outputTimestamps.push(outputTime);
        }

        updateProgress('processing', `Processing ${totalOutputFrames} frames...`, 30);

        // Use samplesAtTimestamps for efficient random-access decoding
        // This uses Mediabunny's optimized pipeline that decodes each packet at most once
        let emittedCount = 0;
        const samplesIterator = sink.samplesAtTimestamps(sourceTimestamps);

        for await (const sample of samplesIterator) {
          if (!sample) {
            console.warn(`[SpeedCurve] Null sample at index ${emittedCount}, skipping`);
            emittedCount++;
            continue;
          }

          const outputTime = outputTimestamps[emittedCount];

          await emitSample(sample, outputTime, minFrameInterval);
          sample.close();
          emittedCount++;

          // Update progress (30% to 90%)
          if (emittedCount % 10 === 0) {
            const emitProgress = emittedCount / totalOutputFrames;
            updateProgress(
              'processing',
              `Encoding: ${emittedCount}/${totalOutputFrames} frames...`,
              30 + emitProgress * 60
            );
          }
        }

        if (emittedCount === 0) {
          throw new Error('No frames were emitted from source video');
        }

        updateProgress('processing', 'Finalizing output...', 95);

        // Ensure encoder flushes SPS/PPS before finalizing
        await videoSource.close();
        // Step 5: Finalize and get output blob
        await output.finalize();
        const buffer = bufferTarget.buffer;

        if (!buffer) {
          throw new Error('Failed to generate output buffer');
        }

        const outputBlob = new Blob([buffer], { type: 'video/mp4' });

        updateProgress(
          'complete',
          `Successfully created ${(outputBlob.size / 1024 / 1024).toFixed(2)}MB video`,
          100
        );

        return outputBlob;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Speed curve error:', error);

        const errorProgress: SpeedCurveProgress = {
          status: 'error',
          message: `Error: ${errorMessage}`,
          progress: 0,
          error: errorMessage,
        };

        setProgress(errorProgress);
        onProgress?.(errorProgress);

        return null;
      } finally {
        if (input) {
          try {
            input.dispose();
          } catch (e) {
            console.warn('Failed to dispose input:', e);
          }
        }
      }
    },
    []
  );

  const reset = useCallback(() => {
    setProgress({
      status: 'idle',
      message: 'Ready',
      progress: 0,
    });
  }, []);

  return {
    applySpeedCurve,
    progress,
    reset,
  };
};
