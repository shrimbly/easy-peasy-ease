'use client';

import { useState, useCallback } from 'react';
import {
  Input,
  Output,
  VideoSampleSink,
  VideoSampleSource,
  VideoSample,
  EncodedPacketSink,
  BlobSource,
  ALL_FORMATS,
  BufferTarget,
  Mp4OutputFormat,
  canEncodeVideo,
} from 'mediabunny';
import type { Rotation } from 'mediabunny';
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

        // console.log('[Debug] applySpeedCurve input:', {
        //   isBlob: videoBlob instanceof Blob,
        //   isFile: videoBlob instanceof File,
        //   size: videoBlob.size,
        //   type: videoBlob.type,
        //   name: videoBlob instanceof File ? videoBlob.name : 'anonymous-blob'
        // });

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

        // Step 2: Create sink to read samples
        updateProgress('processing', 'Creating video sample sink...', 10);

        const sink = new VideoSampleSink(videoTrack);

        // Analyze metadata up front so we can adapt easing to the source
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

        // Helper to determine actual content duration by scanning packets (no decoding)
        // Using EncodedPacketSink is much faster and lighter on resources than VideoSampleSink
        const scanActualDuration = async (blob: Blob): Promise<{
          firstTimestamp: number;
          lastTimestamp: number;
          duration: number;
          packetCount: number;
        }> => {
          updateProgress('processing', 'Scanning video duration...', 12);
          
          const scanSource = new BlobSource(blob);
          const scanInput = new Input({ source: scanSource, formats: ALL_FORMATS });
          
          try {
            const scanTracks = await scanInput.getVideoTracks();
            if (scanTracks.length === 0) {
              console.warn('[Debug] No video tracks found during scan');
              scanInput.dispose();
              return { firstTimestamp: 0, lastTimestamp: 0, duration: 0, packetCount: 0 };
            }
            
            const scanTrack = scanTracks[0];
            const packetSink = new EncodedPacketSink(scanTrack);
            
            let minT = Infinity;
            let maxT = -Infinity;
            let lastDur = 0;
            let packetCount = 0;
            
            // Iterate all packets to find exact bounds
            // This is lightweight as it only reads container headers
            for await (const packet of packetSink.packets()) {
              const t = packet.timestamp;
              const d = packet.duration;
              
              if (t < minT) minT = t;
              if (t > maxT) maxT = t;
              lastDur = d;
              packetCount++;
            }
            
            // Dispose input to free file handle
            scanInput.dispose();
            
            if (!Number.isFinite(minT) || !Number.isFinite(maxT)) {
              return { firstTimestamp: 0, lastTimestamp: 0, duration: 0, packetCount: 0 };
            }
            
            // Calculate duration: (last_start - first_start) + last_duration
            const duration = (maxT - minT) + lastDur;
            return {
              firstTimestamp: minT,
              lastTimestamp: maxT,
              duration,
              packetCount
            };
          } catch (e) {
             console.warn('Error scanning duration:', e);
             try { scanInput.dispose(); } catch {}
             return { firstTimestamp: 0, lastTimestamp: 0, duration: 0, packetCount: 0 };
          }
        };

        // Scan for actual duration using the blob (safer than reusing track)
        const { firstTimestamp: scannedFirstT, duration: scannedDuration, packetCount } = await scanActualDuration(videoBlob);
        
        let effectiveInputDuration = 
          scannedDuration > 0 ? scannedDuration :
          (typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) && metadata.duration > 0
            ? metadata.duration
            : inputDuration);
            
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
        const sourceFrameRate =
          typeof metadata.frameRate === 'number' && Number.isFinite(metadata.frameRate)
            ? metadata.frameRate
            : TARGET_FRAME_RATE;
        const targetFramerate = Math.min(
          MAX_OUTPUT_FPS,
          Math.max(15, Math.round(sourceFrameRate))
        );

        type VideoTier = {
          width: number;
          height: number;
          bitrate: number;
          codec: string;
          label: string;
        };

        // Define fallback tiers
        const tiers: VideoTier[] = [
          // Tier 1: Original Resolution (if 4K or high bitrate)
          {
            width: sourceWidth,
            height: sourceHeight,
            bitrate: resolvedBitrate,
            codec: AVC_LEVEL_5_1,
            label: 'Original'
          },
          // Tier 2: 1080p (Max 15Mbps)
          {
            width: Math.min(sourceWidth, 1920),
            height: Math.min(sourceHeight, 1080),
            bitrate: Math.min(resolvedBitrate, 15_000_000),
            codec: AVC_LEVEL_4_0,
            label: '1080p'
          },
          // Tier 3: 720p (Max 5Mbps)
          {
            width: Math.min(sourceWidth, 1280),
            height: Math.min(sourceHeight, 720),
            bitrate: Math.min(resolvedBitrate, 5_000_000),
            codec: 'avc1.42001f', // Level 3.1
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

        output.addVideoTrack(videoSource, { rotation: trackRotation });

        updateProgress('processing', 'Starting output encoding...', 25);

        await output.start();

        // Step 4: Process each sample with speed curve - INDEX BASED STRATEGY
        // Instead of relying on timestamps (which can be unreliable on Android), we map the *index*
        // of the frame to the output time. This ensures we always use exactly the frames we have
        // to fill the 1.5s output, creating an "elastic" timeline that never freezes.
        let processedSamples = 0;
        
        // We scan for packet count, but if the decoder drops frames, we might get fewer.
        // We'll use the scanned count as the "expected" count for the curve.
        const expectedSampleCount = packetCount > 0 ? packetCount : Math.ceil(effectiveInputDuration * 30);
        
        // Track timeline to ensure monotonicity
        let lastOutputTimestamp = 0;
        let lastOutputClone: VideoSampleLike | null = null;

        const emitSample = async (
          sourceSample: VideoSampleLike,
          timestamp: number,
          duration: number,
          replaceLastClone: boolean = true
        ) => {
          const outputSample = sourceSample.clone();
          outputSample.setTimestamp(timestamp);
          outputSample.setDuration(duration);
          await videoSource.add(outputSample);
          if (replaceLastClone) {
            if (lastOutputClone) {
              lastOutputClone.close();
            }
            lastOutputClone = outputSample.clone();
          }
          outputSample.close();
        };

        // Use a generous duration for the sink to ensure we catch stragglers,
        // but the logic is now driven by sample index.
        const processingLimit = effectiveInputDuration * 2.0;

        for await (const sample of sink.samples(0, processingLimit)) {
          const originalDur = sample.duration ?? TARGET_FRAME_DURATION;

          // Elastic Warping: Map sample index to time [0, 1]
          // We assume the current sample is at index `processedSamples`.
          // We map its "start" and "end" in index-space to the output time.
          
          const progressStart = processedSamples / expectedSampleCount;
          const progressEnd = (processedSamples + 1) / expectedSampleCount;

          // Apply easing to the normalized progress [0, 1]
          // The easing function maps domain [0, 1] to range [0, 1]
          // We then scale by outputDuration to get seconds.
          const easingFunc = typeof easingToUse === 'string' 
            ? (t: number) => warpTime(t * effectiveInputDuration, effectiveInputDuration, 1, easingToUse) // reuse warpTime for curve shape
            : (t: number) => {
                // If it's a raw function, we need to check if it expects 0-1 or seconds. 
                // Typically our easing functions are 0-1.
                // Let's assume standard easing signature: f(t) -> 0..1
                return typeof easingToUse === 'function' ? easingToUse(t) : t;
            };
            
          // Actually, `warpTime` is designed to take (time, inputDur, outputDur).
          // We can just treat "1.0" as the input duration and "outputDuration" as the output.
          // So warpTime(progress, 1.0, outputDuration) works perfect.
          
          const startT = warpTime(progressStart, 1.0, outputDuration, easingToUse);
          const endT = warpTime(progressEnd, 1.0, outputDuration, easingToUse);
          
          const sampleDuration = Math.max(MIN_SAMPLE_DURATION, endT - startT);
          const sampleTimestamp = startT;

          // Ensure monotonicity and fill gaps
          const safeTimestamp = Math.max(sampleTimestamp, lastOutputTimestamp);
          
          // If we have gone past the output duration, stop.
          if (safeTimestamp >= outputDuration - MIN_SAMPLE_DURATION) {
             sample.close();
             break;
          }
          
          // Clip duration if it extends past output limit
          const clippedDuration = Math.min(sampleDuration, outputDuration - safeTimestamp);

          if (clippedDuration > 0) {
             await emitSample(sample, safeTimestamp, clippedDuration);
             lastOutputTimestamp = safeTimestamp + clippedDuration;
          }
          
          sample.close();
          processedSamples++;

          // Update progress
          if (processedSamples % 10 === 0) {
            updateProgress(
              'processing',
              `Processing frames: ${processedSamples}/${expectedSampleCount}...`,
              25 + Math.min(65, (processedSamples / expectedSampleCount) * 65)
            );
          }
        }

        // Tail handling: If we have fewer samples than expected (decoder drop),
        // we might have a small gap at the end.
        // OR if we had more samples, the loop broke early.
        // In the "fewer samples" case, we stretch the last frame to fill.
        const remainingDuration = Math.max(0, outputDuration - lastOutputTimestamp);
        if (remainingDuration > MIN_SAMPLE_DURATION && lastOutputClone) {
           await emitSample(lastOutputClone, lastOutputTimestamp, remainingDuration, false);
           lastOutputTimestamp += remainingDuration;
        }

        const cloneToDispose = lastOutputClone as unknown as { close(): void } | null;
        if (cloneToDispose) {
          cloneToDispose.close();
        }
        lastOutputClone = null;

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
