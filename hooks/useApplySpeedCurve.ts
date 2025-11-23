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
import { type EasingFunction, getEasingFunction } from '@/lib/easing-functions';
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
import { createAvcEncodingConfig, AVC_LEVEL_4_0, AVC_LEVEL_4_2, AVC_LEVEL_5_1 } from '@/lib/video-encoding';

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

  // Helper for linear sanitization pass
  const sanitizeVideo = useCallback(
    async (
      blob: Blob,
      onProgress: (msg: string, p: number) => void
    ): Promise<Blob> => {
      let input: Input | null = null;
      try {
        onProgress('Sanitizing input video...', 0);
        
        const source = new BlobSource(blob);
        input = new Input({ source, formats: ALL_FORMATS });
        
        const tracks = await input.getVideoTracks();
        if (tracks.length === 0) throw new Error('No video track for sanitization');
        
        const track = tracks[0];
        const sink = new VideoSampleSink(track);
        
        const dim = await getVideoDimensions(blob);
        // Downscale to safe 720p max for mobile robustness to rule out memory exhaustion
        const scale = Math.min(1280 / dim.width, 720 / dim.height, 1.0);
        const safeWidth = Math.round(dim.width * scale) & ~1; 
        const safeHeight = Math.round(dim.height * scale) & ~1;
        
        // Ultra-Safe config: 4Mbps, Baseline Profile (Level 3.1)
        // This uses the simplest encoding possible to ensure mobile hardware can keep up.
        const config = createAvcEncodingConfig(
            4_000_000,
            safeWidth,
            safeHeight,
            'avc1.42001f', // Baseline 3.1
            30
        );
        
        console.log('[analysis] Sanitization Encoder Config:', JSON.stringify(config));
        
        const videoSource = new VideoSampleSource(config);
        const bufferTarget = new BufferTarget();
        const output = new Output({
            format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
            target: bufferTarget
        });
        
        output.addVideoTrack(videoSource, { rotation: normalizeRotation(track.rotation as number) });
        await output.start();
        
        // Linear Copy with FORCE DECODE
        let processed = 0;
        // Estimate frame count for progress
        const estimatedFrames = 120; 
        
        for await (const sample of sink.samples(0, Infinity)) {
            // FORCE DECODE: Create a bitmap to force the decoder to actually render pixels.
            // Mobile decoders are lazy and might return a frame before it's ready, leading to frozen output.
            // Awaiting createImageBitmap forces synchronization.
            let videoFrame: VideoFrame | null = null;
            let bitmap: ImageBitmap | null = null;
            try {
                // Use the native VideoFrame to create the bitmap
                // We must close this frame afterwards
                // @ts-ignore - VideoSample has toVideoFrame method
                videoFrame = sample.toVideoFrame();
                bitmap = await createImageBitmap(videoFrame);
            } catch (e) {
                console.warn('Failed to create bitmap for sync (ignoring):', e);
            } finally {
                if (bitmap) {
                    bitmap.close();
                }
                if (videoFrame) {
                    videoFrame.close();
                }
            }

            const outSample = sample.clone();
            await videoSource.add(outSample);
            
            outSample.close();
            sample.close();
            
            processed++;
            if (processed % 10 === 0) {
                onProgress('Sanitizing input video...', Math.min(90, (processed / estimatedFrames) * 100));
            }
        }
        
        await videoSource.close();
        await output.finalize();
        
        if (!bufferTarget.buffer) throw new Error('Sanitization failed');
        return new Blob([bufferTarget.buffer], { type: 'video/mp4' });
      } finally {
        if (input) input.dispose();
      }
    }, 
    []
  );

  const applySpeedCurve = useCallback(
    async (
      rawVideoBlob: Blob,
      inputDuration: number = DEFAULT_INPUT_DURATION,
      outputDuration: number = DEFAULT_OUTPUT_DURATION,
      onProgress?: (progress: SpeedCurveProgress) => void,
      easingFunction: EasingFunction | string = DEFAULT_EASING,
      bitrate: number = DEFAULT_BITRATE
    ): Promise<Blob | null> => {
      let input: Input | null = null;
      // Hoist currentInputSample to ensure it is closed in finally block if loop crashes
      let currentInputSample: VideoSampleLike | null = null;

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

        // PHASE 1: SANITIZE INPUT
        // Mobile decoders struggle with the complex Level 5.0 / Long GOP structure of source videos
        // when performing the random-access seeking required for speed curves.
        // We first linear-copy the video to a "Safe" (Level 4.0, 1080p) format.
        const videoBlob = await sanitizeVideo(rawVideoBlob, (msg, p) => {
            updateProgress('processing', msg, p * 0.3); // Sanitize is 30% of total progress
        });
        
        updateProgress('processing', 'Starting speed curve application...', 30);

        // PHASE 2: APPLY CURVE
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
        // Cap bitrate to 8Mbps to prevent mobile decoder exhaustion/freezing
        const MOBILE_SAFE_BITRATE_CAP = 8_000_000;
        resolvedBitrate = Math.min(Math.max(1, Math.floor(resolvedBitrate)), MOBILE_SAFE_BITRATE_CAP);

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
          bitrate: resolvedBitrate,
          frameRate,
        };
        
        const shouldAdaptCurve =
          typeof easingFunction === 'string' && easingFunction === DEFAULT_EASING;
        const adaptiveSelection = shouldAdaptCurve ? selectAdaptiveEasing(metadata) : null;
        const easingToUse: EasingFunction | string =
          adaptiveSelection?.easingFunction ?? easingFunction;
          
        // Helper to count exact decodable frames (Pass 1)
        const countDecodableFrames = async (blob: Blob): Promise<number> => {
          updateProgress('processing', 'Analyzing structure...', 35);

          const scanSource = new BlobSource(blob);
          const scanInput = new Input({ source: scanSource, formats: ALL_FORMATS });

          try {
            const scanTracks = await scanInput.getVideoTracks();
            if (scanTracks.length === 0) {
              return 0;
            }

            const scanTrack = scanTracks[0];
            const scanSink = new VideoSampleSink(scanTrack);

            let count = 0;
            // Drain all samples to count them
            for await (const sample of scanSink.samples(0, Infinity)) {
              count++;
              sample.close();
            }
            return count;
          } catch (e) {
            console.warn('Error counting frames:', e);
            return 0;
          } finally {
            scanInput.dispose();
          }
        };

        // Pass 1: Count exact frames
        const exactFrameCount = await countDecodableFrames(videoBlob);

        if (exactFrameCount === 0) {
          throw new Error('Could not decode any frames from the input video');
        }

        // Use the metadata duration as a fallback for display, but logic relies on frame count
        let effectiveInputDuration =
          (typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) && metadata.duration > 0
            ? metadata.duration
            : inputDuration);

        // REFRESH INPUT STATE:
        try {
            if (input) {
                input.dispose();
                input = null;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (e) {
            console.warn('Failed to dispose metadata input:', e);
        }

        // Step 3: Create output with video source
        updateProgress('processing', 'Configuring encoder...', 40);
        
        // Create FRESH input for encoding
        const encodingSource = new BlobSource(videoBlob);
        input = new Input({
          source: encodingSource,
          formats: ALL_FORMATS,
        });
        
        const encodingTracks = await input.getVideoTracks();
        if (encodingTracks.length === 0) {
             throw new Error('Failed to re-open video tracks for encoding');
        }
        const encodingTrack = encodingTracks[0];
        const encodingSink = new VideoSampleSink(encodingTrack);

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
          // Tier 1: Original Resolution (using Constrained Baseline 4.2 for mobile compatibility)
          {
            width: sourceWidth,
            height: sourceHeight,
            bitrate: resolvedBitrate,
            codec: AVC_LEVEL_4_2,
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
            'Device encoder does not support the required H.264 profiles for this video.'
          );
        }

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

        updateProgress('processing', 'Starting output encoding...', 45);

        await output.start();

        // Step 4: Process each sample with speed curve - RESAMPLING STRATEGY (Pass 2)
        const outputFrameRate = 30; // Force 30fps CFR for maximum compatibility
        const totalOutputFrames = Math.ceil(outputDuration * outputFrameRate);
        const frameDuration = 1 / outputFrameRate;
        
        let currentInputFrameIndex = 0;

        // Resolve easing function directly
        const easing = typeof easingToUse === 'string'
            ? getEasingFunction(easingToUse)
            : easingToUse;

        const sampleIterator = encodingSink.samples(0, effectiveInputDuration * 2.0);

        // Initialize first sample
        const nextSample = await sampleIterator.next();
        if (!nextSample.done) {
          currentInputSample = nextSample.value;
        }
        
        for (let i = 0; i < totalOutputFrames; i++) {
          // 1. Calculate progress in Output Time [0, 1]
          const progressOut = i / (totalOutputFrames - 1);

          // 2. Map Output Progress -> Input Progress (Direct easing)
          const progressIn = easing(progressOut);

          // 3. Determine which Input Frame corresponds to this progress
          const targetInputIndex = Math.min(
            exactFrameCount - 1,
            Math.round(progressIn * (exactFrameCount - 1))
          );
          
          // 4. Advance input stream until we reach the target frame
          while (currentInputFrameIndex < targetInputIndex && currentInputSample) {
            const result = await sampleIterator.next();
            
            // No throttling needed anymore because input video is now "Safe" (linear sanitize pass)
            // The mobile decoder can handle skipping on the sanitized Level 4.0 stream.
            // PROVIDED WE HAVE KEYFRAMES (which we now do).

            if (result.done) {
              break;
            }

            // Close the old sample as we are done with it
            currentInputSample.close();
            currentInputSample = result.value;
            currentInputFrameIndex++;
          }

          // 5. Emit the current frame
          if (currentInputSample) {
            const outputSample = currentInputSample.clone();
            try {
              const timestamp = i * frameDuration;
              outputSample.setTimestamp(timestamp);
              outputSample.setDuration(frameDuration);
              
              if (i >= totalOutputFrames - 15) {
                 // Validate monotonicity of input samples near the end
                 console.log(`[analysis] Frame ${i}: InputTS=${currentInputSample.timestamp}, OutputTS=${timestamp.toFixed(4)}`);
              }
              
              await videoSource.add(outputSample);
            } finally {
              outputSample.close();
            }
          }

          // Update progress (scale 45% -> 95%)
          if (i % 10 === 0) {
            updateProgress(
              'processing',
              `Resampling frames: ${i}/${totalOutputFrames}...`,
              45 + Math.min(50, (i / totalOutputFrames) * 50)
            );
          }
        }
        
        // CRITICAL FIX FOR MOBILE: "Sacrificial Frame"
        if (currentInputSample) {
             const paddingSample = currentInputSample.clone();
             try {
                 const paddingTimestamp = totalOutputFrames * frameDuration;
                 paddingSample.setTimestamp(paddingTimestamp);
                 paddingSample.setDuration(frameDuration);
                 console.log(`[analysis] Emitting SACRIFICIAL Padding Frame: ts=${paddingTimestamp.toFixed(4)}`);
                 await videoSource.add(paddingSample);
             } catch (e) {
                 console.warn('Failed to add padding frame:', e);
             } finally {
                 paddingSample.close();
             }
        }

        // Clean up the last sample
        if (currentInputSample) {
          currentInputSample.close();
          currentInputSample = null;
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
        // CRITICAL: Ensure any held sample is closed to prevent memory leaks
        if (currentInputSample) {
            try {
                currentInputSample.close();
            } catch (e) {
                console.warn('Failed to close leaked sample:', e);
            }
            currentInputSample = null;
        }

        if (input) {
          try {
            input.dispose();
          } catch (e) {
            console.warn('Failed to dispose input:', e);
          }
        }
      }
    },
    [sanitizeVideo]
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
