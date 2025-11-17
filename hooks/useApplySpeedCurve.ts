'use client';

import { useState, useCallback } from 'react';
import {
  Input,
  Output,
  VideoSampleSink,
  VideoSampleSource,
  VideoSample,
  BlobSource,
  ALL_FORMATS,
  BufferTarget,
  Mp4OutputFormat,
} from 'mediabunny';
import {
  warpTime,
  calculateWarpedDuration,
  selectAdaptiveEasing,
  type VideoCurveMetadata,
} from '@/lib/speed-curve';
import type { EasingFunction } from '@/lib/easing-functions';
import {
  DEFAULT_BITRATE,
  TARGET_FRAME_RATE,
  TARGET_FRAME_DURATION,
  MIN_OUTPUT_FRAME_DURATION,
  MIN_SAMPLE_DURATION,
  DEFAULT_INPUT_DURATION,
  DEFAULT_OUTPUT_DURATION,
  DEFAULT_EASING,
} from '@/lib/speed-curve-config';
import { createAvcEncodingConfig } from '@/lib/video-encoding';

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
        const input = new Input({
          source: blobSource,
          formats: ALL_FORMATS,
        });
        const videoTracks = await input.getVideoTracks();

        if (videoTracks.length === 0) {
          throw new Error('No video tracks found in input');
        }

        const videoTrack = videoTracks[0];

        // Step 2: Create sink to read samples
        updateProgress('processing', 'Creating video sample sink...', 10);

        const sink = new VideoSampleSink(videoTrack);

        // Analyze metadata up front so we can adapt easing to the source
        const [trackDuration, containerDuration, packetStats] = await Promise.all([
          videoTrack.computeDuration().catch(() => null),
          input.computeDuration().catch(() => null),
          videoTrack
            .computePacketStats()
            .catch((statsError) => {
              console.warn('Failed to compute packet stats', statsError);
              return null;
            }),
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
        updateProgress('processing', 'Creating output...', 20);

        const videoSource = new VideoSampleSource(
          createAvcEncodingConfig(resolvedBitrate)
        );

        const bufferTarget = new BufferTarget();
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target: bufferTarget,
        });

        output.addVideoTrack(videoSource);

        updateProgress('processing', 'Starting output encoding...', 25);

        await output.start();

        // Step 4: Process each sample with speed curve
        let processedSamples = 0;
        const processingDuration = effectiveInputDuration;
        let pendingSample: VideoSample | null = null;
        let pendingTimestamp = 0;
        let pendingDuration = 0;
        let timelineOffset: number | null = null;
        let lastOutputTimestamp = 0;

        const flushPendingSample = async (force = false) => {
          if (!pendingSample) {
            return;
          }
          if (!force && pendingDuration < MIN_OUTPUT_FRAME_DURATION) {
            return;
          }
          if (timelineOffset === null) {
            timelineOffset = pendingTimestamp;
          }
          const normalizedTimestamp = pendingTimestamp - timelineOffset;
          const safeTimestamp = Math.max(normalizedTimestamp, lastOutputTimestamp);
          const remainingDuration = Math.max(0, outputDuration - safeTimestamp);
          const desiredDuration = Math.max(MIN_SAMPLE_DURATION, pendingDuration);
          const safeDuration = force
            ? Math.max(MIN_SAMPLE_DURATION, remainingDuration)
            : Math.min(desiredDuration, Math.max(MIN_SAMPLE_DURATION, remainingDuration));
          pendingSample.setTimestamp(safeTimestamp);
          pendingSample.setDuration(safeDuration);
          await videoSource.add(pendingSample);
          pendingSample.close();
          pendingSample = null;
          pendingDuration = 0;
          lastOutputTimestamp = safeTimestamp + safeDuration;
        };

        for await (const sample of sink.samples(0, processingDuration)) {
          const originalT = sample.timestamp ?? 0;
          const originalDur = sample.duration ?? TARGET_FRAME_DURATION;

          // Apply the configured easing curve when remapping time
          const newT = warpTime(originalT, effectiveInputDuration, outputDuration, easingToUse);
          const newDur = calculateWarpedDuration(
            originalT,
            originalDur,
            effectiveInputDuration,
            outputDuration,
            easingToUse
          );

          const normalizedDuration = Math.max(MIN_SAMPLE_DURATION, newDur);

          if (!pendingSample) {
            pendingSample = sample.clone();
            pendingTimestamp = newT;
            pendingDuration = normalizedDuration;
          } else {
            pendingDuration += normalizedDuration;
          }

          sample.close();
          await flushPendingSample();

          processedSamples++;

          // Update progress every 10 frames
          if (processedSamples % 10 === 0) {
            updateProgress(
              'processing',
              `Processing frames: ${processedSamples}...`,
              25 + Math.min(65, (processedSamples / 300) * 65)
            );
          }
        }

        await flushPendingSample(true);

        updateProgress('processing', 'Finalizing output...', 95);

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
