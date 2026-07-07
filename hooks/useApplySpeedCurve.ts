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
} from 'mediabunny';
import type { Rotation } from 'mediabunny';
import {
  selectAdaptiveEasing,
  buildEasedSourceTimestamps,
  type VideoCurveMetadata,
} from '@/lib/speed-curve';
import { getEasingFunction, type EasingFunction } from '@/lib/easing-functions';
import type { RenderQuality } from '@/lib/types';
import {
  TARGET_FRAME_RATE,
  DEFAULT_INPUT_DURATION,
  DEFAULT_OUTPUT_DURATION,
  DEFAULT_EASING,
  MAX_OUTPUT_FPS,
  PREVIEW_FPS,
} from '@/lib/speed-curve-config';
import { buildEncodeTiers, type SourceVideoInfo } from '@/lib/encode-planner';
import { createTierEncodingConfig, selectSupportedTier } from '@/lib/video-encoding';
import { throwIfAborted, isAbortError } from '@/lib/abort-utils';

type VideoSampleLike = Parameters<VideoSampleSource['add']>[0];

interface SpeedCurveProgress {
  status: 'idle' | 'processing' | 'complete' | 'error';
  message: string;
  progress: number; // 0-100
  error?: string;
}

export interface ApplySpeedCurveOptions {
  /** Used only when the source duration cannot be read from the file */
  inputDuration?: number;
  outputDuration?: number;
  easing?: EasingFunction | string;
  quality?: RenderQuality;
  signal?: AbortSignal;
  onProgress?: (progress: SpeedCurveProgress) => void;
  /**
   * "Split a video" mode: retime only this sub-range of the source (seconds
   * from the source's first frame). When omitted, the whole clip is used.
   * `sourceEndTime` defaults to the end of the clip when only a start is given.
   */
  sourceStartTime?: number;
  sourceEndTime?: number;
}

interface UseApplySpeedCurveReturn {
  applySpeedCurve: (videoBlob: Blob, options?: ApplySpeedCurveOptions) => Promise<Blob | null>;
  progress: SpeedCurveProgress;
  reset: () => void;
}

interface SourceProbe {
  codedWidth: number;
  codedHeight: number;
  rotation: Rotation;
  firstTimestamp: number;
  endTimestamp: number;
  frameRate: number;
  bitrate?: number;
}

const probeSource = async (videoBlob: Blob, fallbackDuration: number): Promise<SourceProbe> => {
  const input = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error('No video track found in input');
    }

    const [codedWidth, codedHeight, rotation, firstTimestamp, endTimestamp, packetStats] =
      await Promise.all([
        videoTrack.getCodedWidth(),
        videoTrack.getCodedHeight(),
        videoTrack.getRotation(),
        videoTrack.getFirstTimestamp().catch(() => 0),
        videoTrack.computeDuration().catch(() => null),
        videoTrack.computePacketStats().catch(() => null),
      ]);

    const resolvedEnd =
      typeof endTimestamp === 'number' && Number.isFinite(endTimestamp) && endTimestamp > firstTimestamp
        ? endTimestamp
        : firstTimestamp + fallbackDuration;

    return {
      codedWidth,
      codedHeight,
      rotation,
      firstTimestamp,
      endTimestamp: resolvedEnd,
      frameRate:
        packetStats?.averagePacketRate && Number.isFinite(packetStats.averagePacketRate)
          ? packetStats.averagePacketRate
          : TARGET_FRAME_RATE,
      bitrate:
        packetStats?.averageBitrate && Number.isFinite(packetStats.averageBitrate)
          ? packetStats.averageBitrate
          : undefined,
    };
  } finally {
    input.dispose();
  }
};

/**
 * Hook for applying speed curves to video using Mediabunny.
 *
 * Output-driven frame emission: for each output frame slot we compute which
 * source timestamp the easing curve calls for, then pull those frames via
 * mediabunny's random-access decode pipeline and re-encode on a fixed output
 * grid. Encoder parameters come from the capability-probed tier ladder in
 * lib/encode-planner, so every machine gets the best plan it can execute.
 */
export const useApplySpeedCurve = (): UseApplySpeedCurveReturn => {
  const [progress, setProgress] = useState<SpeedCurveProgress>({
    status: 'idle',
    message: 'Ready',
    progress: 0,
  });

  const applySpeedCurve = useCallback(
    async (videoBlob: Blob, options: ApplySpeedCurveOptions = {}): Promise<Blob | null> => {
      const {
        inputDuration = DEFAULT_INPUT_DURATION,
        outputDuration = DEFAULT_OUTPUT_DURATION,
        easing: easingOption = DEFAULT_EASING,
        quality = 'full',
        signal,
        onProgress,
        sourceStartTime,
        sourceEndTime,
      } = options;
      const isPreview = quality === 'preview';

      const updateProgress = (
        status: SpeedCurveProgress['status'],
        message: string,
        progressValue: number
      ) => {
        const p: SpeedCurveProgress = { status, message, progress: progressValue };
        setProgress(p);
        onProgress?.(p);
      };

      try {
        updateProgress('processing', 'Analyzing video metadata...', 5);
        throwIfAborted(signal);

        const source = await probeSource(videoBlob, inputDuration);
        const sourceSpan = source.endTimestamp - source.firstTimestamp;

        // Resolve the section span. sourceStartTime/sourceEndTime are offsets
        // from the source's first frame; map them to absolute track time and
        // clamp inside [firstTimestamp, endTimestamp]. Absent -> whole clip.
        const clampToTrack = (t: number) =>
          Math.min(Math.max(t, source.firstTimestamp), source.endTimestamp);
        const spanStart =
          sourceStartTime != null && Number.isFinite(sourceStartTime)
            ? clampToTrack(source.firstTimestamp + sourceStartTime)
            : source.firstTimestamp;
        const spanEnd =
          sourceEndTime != null && Number.isFinite(sourceEndTime)
            ? Math.max(spanStart, clampToTrack(source.firstTimestamp + sourceEndTime))
            : source.endTimestamp;
        const spanDuration = spanEnd - spanStart;
        const effectiveInputDuration =
          spanDuration > 0 ? spanDuration : sourceSpan > 0 ? sourceSpan : inputDuration;

        // Adapt the default curve to the source material; explicit user
        // choices are respected untouched.
        const metadata: VideoCurveMetadata = {
          duration: effectiveInputDuration,
          bitrate: source.bitrate ?? 0,
          frameRate: source.frameRate,
        };
        const shouldAdaptCurve = typeof easingOption === 'string' && easingOption === DEFAULT_EASING;
        const adaptiveSelection = shouldAdaptCurve ? selectAdaptiveEasing(metadata) : null;
        const easingFunc: EasingFunction =
          adaptiveSelection?.easingFunction ??
          (typeof easingOption === 'string' ? getEasingFunction(easingOption) : easingOption);

        updateProgress(
          'processing',
          `Metadata analyzed (${effectiveInputDuration.toFixed(2)}s @ ${source.frameRate.toFixed(1)}fps)` +
            (adaptiveSelection ? ` -> ${adaptiveSelection.easingName}` : ''),
          18
        );
        throwIfAborted(signal);

        // Plan encoding: probe the tier ladder with the exact configs we will
        // encode with, so "supported" cannot diverge from reality.
        updateProgress('processing', 'Selecting encoder configuration...', 20);
        const sourceInfo: SourceVideoInfo = {
          width: source.codedWidth,
          height: source.codedHeight,
          bitrate: source.bitrate,
        };
        const frameRates = isPreview ? [PREVIEW_FPS] : [MAX_OUTPUT_FPS, PREVIEW_FPS];
        const tiers = buildEncodeTiers(sourceInfo, quality, frameRates);
        const tier = await selectSupportedTier(tiers);

        if (!tier) {
          throw new Error(
            'This device cannot encode H.264 video at any supported resolution. ' +
              'Try a different browser (Chrome or Edge work best) or a smaller source video.'
          );
        }

        updateProgress(
          'processing',
          `Encoder selected: ${tier.label} (${tier.width}x${tier.height} @ ${tier.frameRate}fps)`,
          22
        );

        const encodePass = async (useFallbackReaders: boolean): Promise<Blob> => {
          throwIfAborted(signal);

          const input = new Input({
            source: new BlobSource(videoBlob, useFallbackReaders ? { useStreamReader: false } : undefined),
            formats: ALL_FORMATS,
          });
          const videoSource = new VideoSampleSource(createTierEncodingConfig(tier));
          const bufferTarget = new BufferTarget();
          const output = new Output({
            format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
            target: bufferTarget,
          });
          output.addVideoTrack(videoSource, { rotation: source.rotation, frameRate: tier.frameRate });

          try {
            const videoTrack = await input.getPrimaryVideoTrack();
            if (!videoTrack) {
              throw new Error('No video track found in input');
            }
            const sink = new VideoSampleSink(
              videoTrack,
              useFallbackReaders ? { hardwareAcceleration: 'prefer-software' } : undefined
            );

            await output.start();

            const minFrameInterval = 1 / tier.frameRate;
            const totalOutputFrames = Math.max(1, Math.round(outputDuration * tier.frameRate));

            // Pre-compute the source timestamp each output frame slot needs.
            // In "Split a video" mode this samples only [spanStart, spanEnd];
            // in whole-clip mode the span is the entire track. Timestamps are
            // anchored at the track's real first timestamp (Android camera
            // clips often do not start at zero) and clamped inside the last
            // frame so end-of-section requests cannot fall off the track.
            const sourceTimestamps = buildEasedSourceTimestamps({
              spanStart,
              spanEnd,
              trackEnd: source.endTimestamp,
              easing: easingFunc,
              outputFrameCount: totalOutputFrames,
              minFrameInterval,
            });

            updateProgress('processing', `Processing ${totalOutputFrames} frames...`, 30);

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

            // Decoders on some platforms (notably Android MediaCodec) fail to
            // emit frames near track edges. Rather than dropping those output
            // slots (which visibly truncates eased endings), hold the nearest
            // decoded frame: trailing nulls repeat the previous frame, leading
            // nulls are backfilled by the first frame that arrives.
            let heldSample: VideoSampleLike | null = null;
            let pendingSlots: number[] = [];
            let decodedCount = 0;
            let slotIndex = 0;

            for await (const sample of sink.samplesAtTimestamps(sourceTimestamps)) {
              throwIfAborted(signal);
              const outputTime = slotIndex * minFrameInterval;

              if (sample) {
                for (const pending of pendingSlots) {
                  await emitSample(sample, pending * minFrameInterval, minFrameInterval);
                }
                pendingSlots = [];
                await emitSample(sample, outputTime, minFrameInterval);
                heldSample?.close();
                heldSample = sample;
                decodedCount++;
              } else if (heldSample) {
                await emitSample(heldSample, outputTime, minFrameInterval);
              } else {
                pendingSlots.push(slotIndex);
              }

              slotIndex++;
              if (slotIndex % 10 === 0) {
                updateProgress(
                  'processing',
                  `Encoding: ${slotIndex}/${totalOutputFrames} frames...`,
                  30 + (slotIndex / totalOutputFrames) * 60
                );
              }
            }
            heldSample?.close();

            if (decodedCount === 0) {
              throw new Error('No frames could be decoded from the source video');
            }

            updateProgress('processing', 'Finalizing output...', 95);
            await videoSource.close();
            await output.finalize();

            const buffer = bufferTarget.buffer;
            if (!buffer) {
              throw new Error('Failed to generate output buffer');
            }
            return new Blob([buffer], { type: 'video/mp4' });
          } catch (error) {
            await output.cancel().catch(() => {});
            throw error;
          } finally {
            input.dispose();
          }
        };

        let outputBlob: Blob;
        try {
          outputBlob = await encodePass(false);
        } catch (firstError) {
          if (isAbortError(firstError)) throw firstError;
          // Retry once with the conservative pipeline: software-preference
          // decoding and mediabunny's more primitive (but more stable) Blob
          // reader — recovers machines with flaky hardware decoders or Blob
          // streaming (seen on Android and older Safari).
          console.warn('Speed curve encode failed, retrying with conservative pipeline:', firstError);
          updateProgress('processing', 'Retrying with compatibility mode...', 25);
          outputBlob = await encodePass(true);
        }

        updateProgress(
          'complete',
          `Successfully created ${(outputBlob.size / 1024 / 1024).toFixed(2)}MB video`,
          100
        );
        return outputBlob;
      } catch (error) {
        if (isAbortError(error)) {
          updateProgress('idle', 'Cancelled', 0);
          return null;
        }
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
    setProgress({ status: 'idle', message: 'Ready', progress: 0 });
  }, []);

  return { applySpeedCurve, progress, reset };
};
