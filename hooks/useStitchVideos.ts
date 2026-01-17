'use client';

import { useState, useCallback } from 'react';
import {
  Input,
  Output,
  VideoSampleSink,
  VideoSampleSource,
  AudioBufferSource,
  BlobSource,
  ALL_FORMATS,
  BufferTarget,
  Mp4OutputFormat,
  getFirstEncodableAudioCodec,
  canEncodeVideo,
} from 'mediabunny';
import type { Rotation } from 'mediabunny';
import type { RenderQuality } from '@/lib/types';
import { DEFAULT_BITRATE, MAX_OUTPUT_FPS, PREVIEW_FPS, PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT, PREVIEW_BITRATE } from '@/lib/speed-curve-config';
import { createAvcEncodingConfig, AVC_LEVEL_4_0, AVC_LEVEL_5_1 } from '@/lib/video-encoding';

const FALLBACK_WIDTH = 1920;
const FALLBACK_HEIGHT = 1080;
const BASELINE_PIXEL_LIMIT = 1920 * 1080;

const ensureEvenDimension = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const even = value % 2 === 0 ? value : value - 1;
  return even > 0 ? even : 2;
};

const normalizeRotation = (value: unknown): Rotation => {
  return value === 0 || value === 90 || value === 180 || value === 270 ? value : 0;
};

const probeVideoMetadata = async (
  blob: Blob
): Promise<{ width: number; height: number; rotation: Rotation; bitrate: number }> => {
  const source = new BlobSource(blob);
  const input = new Input({
    source,
    formats: ALL_FORMATS,
  });
  try {
    const videoTracks = await input.getVideoTracks();
    if (videoTracks.length === 0) {
      throw new Error('No video tracks found while probing dimensions.');
    }
    const track = videoTracks[0];
    const widthCandidate =
      (typeof track.displayWidth === 'number' && track.displayWidth > 0
        ? track.displayWidth
        : track.codedWidth) ?? FALLBACK_WIDTH;
    const heightCandidate =
      (typeof track.displayHeight === 'number' && track.displayHeight > 0
        ? track.displayHeight
        : track.codedHeight) ?? FALLBACK_HEIGHT;

    // Probe bitrate from packet stats
    let bitrate = 0;
    try {
      const packetStats = await track.computePacketStats();
      if (packetStats?.averageBitrate && Number.isFinite(packetStats.averageBitrate)) {
        bitrate = packetStats.averageBitrate;
      }
    } catch (e) {
      console.warn('Failed to compute packet stats for bitrate', e);
    }

    return {
      width: ensureEvenDimension(widthCandidate),
      height: ensureEvenDimension(heightCandidate),
      rotation: normalizeRotation(track.rotation),
      bitrate,
    };
  } finally {
    input.dispose();
  }
};

const determineEncodeParameters = async (
  blobs: Blob[]
): Promise<{ width: number; height: number; rotation: Rotation; maxSourceBitrate: number }> => {
  let maxWidth = 0;
  let maxHeight = 0;
  let maxSourceBitrate = 0;
  let rotation: Rotation | null = null;

  for (let i = 0; i < blobs.length; i++) {
    try {
      const { width, height, rotation: trackRotation, bitrate } = await probeVideoMetadata(blobs[i]);
      maxWidth = Math.max(maxWidth, width);
      maxHeight = Math.max(maxHeight, height);
      maxSourceBitrate = Math.max(maxSourceBitrate, bitrate);
      if (rotation === null) {
        rotation = trackRotation;
      } else if (trackRotation !== rotation) {
        console.warn(
          `Rotation mismatch detected for video ${i + 1} (got ${trackRotation}, expected ${rotation}). Using the first rotation value.`
        );
      }
    } catch (error) {
      console.warn(`Failed to probe metadata for video ${i + 1}`, error);
    }
  }

  if (maxWidth <= 0 || maxHeight <= 0) {
    return {
      width: FALLBACK_WIDTH,
      height: FALLBACK_HEIGHT,
      rotation: rotation ?? (0 as Rotation),
      maxSourceBitrate,
    };
  }

  return {
    width: ensureEvenDimension(maxWidth),
    height: ensureEvenDimension(maxHeight),
    rotation: rotation ?? (0 as Rotation),
    maxSourceBitrate,
  };
};

interface StitchProgress {
  status: 'idle' | 'processing' | 'complete' | 'error';
  message: string;
  progress: number; // 0-100
  currentVideo?: number; // Which video is being processed (1-indexed)
  totalVideos?: number;
  error?: string;
}

interface AudioData {
  buffer: AudioBuffer;
  duration: number;
}

interface UseStitchVideosReturn {
  stitchVideos: (
    videoBlobs: Blob[],
    onProgress?: (progress: StitchProgress) => void,
    bitrate?: number,
    audioData?: AudioData,
    quality?: RenderQuality
  ) => Promise<Blob | null>;
  progress: StitchProgress;
  reset: () => void;
}

/**
 * Hook for stitching multiple video blobs together sequentially
 * Reads frames from each video and writes them to output in order
 */
export const useStitchVideos = (): UseStitchVideosReturn => {
  const [progress, setProgress] = useState<StitchProgress>({
    status: 'idle',
    message: 'Ready',
    progress: 0,
  });

  const stitchVideos = useCallback(
    async (
      videoBlobs: Blob[],
      onProgress?: (progress: StitchProgress) => void,
      bitrate: number = DEFAULT_BITRATE,
      audioData?: AudioData,
      quality: RenderQuality = 'full'
    ): Promise<Blob | null> => {
      const isPreview = quality === 'preview';
      try {
        // Reset progress
        const initialProgress: StitchProgress = {
          status: 'processing',
          message: 'Initializing stitching...',
          progress: 0,
          totalVideos: videoBlobs.length,
        };
        setProgress(initialProgress);
        onProgress?.(initialProgress);

        if (videoBlobs.length === 0) {
          throw new Error('No videos to stitch');
        }

        // Helper to update progress
        const updateProgress = (
          status: StitchProgress['status'],
          message: string,
          progressValue: number,
          currentVideo?: number
        ) => {
          const p: StitchProgress = {
            status,
            message,
            progress: progressValue,
            currentVideo,
            totalVideos: videoBlobs.length,
          };
          setProgress(p);
          onProgress?.(p);
        };

        updateProgress('processing', 'Analyzing video metadata...', 5);
        const {
          width: probedWidth,
          height: probedHeight,
          rotation: aggregateRotation,
          maxSourceBitrate,
        } = await determineEncodeParameters(videoBlobs);

        // Apply preview constraints if in preview mode
        let safeWidth = probedWidth > 0 ? probedWidth : FALLBACK_WIDTH;
        let safeHeight = probedHeight > 0 ? probedHeight : FALLBACK_HEIGHT;

        if (isPreview) {
          // Scale down to 720p max while maintaining aspect ratio
          if (safeWidth > PREVIEW_MAX_WIDTH || safeHeight > PREVIEW_MAX_HEIGHT) {
            const scale = Math.min(PREVIEW_MAX_WIDTH / safeWidth, PREVIEW_MAX_HEIGHT / safeHeight);
            safeWidth = ensureEvenDimension(Math.round(safeWidth * scale));
            safeHeight = ensureEvenDimension(Math.round(safeHeight * scale));
          }
        }

        const codecProfile = isPreview
          ? 'avc1.42001f' // Level 3.1 for preview
          : safeWidth * safeHeight > BASELINE_PIXEL_LIMIT ? AVC_LEVEL_5_1 : AVC_LEVEL_4_0;

        // For full quality: use highest of passed/default/source bitrate
        // For preview: cap at PREVIEW_BITRATE
        const candidateBitrate = Math.max(
          Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0,
          DEFAULT_BITRATE,
          Number.isFinite(maxSourceBitrate) && maxSourceBitrate > 0 ? maxSourceBitrate : 0
        );
        const resolvedBitrate = isPreview
          ? Math.min(Math.max(1, Math.floor(candidateBitrate)), PREVIEW_BITRATE)
          : Math.max(1, Math.floor(candidateBitrate));

        const supportsConfig = await canEncodeVideo('avc', {
          width: safeWidth,
          height: safeHeight,
          bitrate: resolvedBitrate,
          fullCodecString: codecProfile,
        });

        if (!supportsConfig) {
          throw new Error(
            `Device encoder cannot output ${safeWidth}x${safeHeight} using profile ${codecProfile}. Reduce the resolution or bitrate and try again.`
          );
        }

        console.log('Stitch encoder configuration', {
          width: safeWidth,
          height: safeHeight,
          codecProfile,
          bitrate: resolvedBitrate,
          maxSourceBitrate,
          requestedBitrate: bitrate,
          rotation: aggregateRotation,
        });

        // Create output once
        updateProgress('processing', 'Creating output container...', 10);

        const videoSource = new VideoSampleSource(
          createAvcEncodingConfig(resolvedBitrate, safeWidth, safeHeight, codecProfile)
        );

        const bufferTarget = new BufferTarget();
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target: bufferTarget,
        });

        const outputFps = isPreview ? PREVIEW_FPS : MAX_OUTPUT_FPS;
        output.addVideoTrack(videoSource, { rotation: aggregateRotation, frameRate: outputFps });

        // Add audio track if provided
        let audioSource: AudioBufferSource | undefined;
        let pendingAudioBuffer: AudioBuffer | null = null;
        if (audioData) {
          updateProgress('processing', 'Detecting supported audio codec...', 8);

          // Detect the best supported audio codec for MP4
          // Try common codecs in order of preference: aac, opus, mp3
          const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus', 'mp3'], {
            numberOfChannels: audioData.buffer.numberOfChannels,
            sampleRate: audioData.buffer.sampleRate,
            bitrate: 128000,
          });

          if (!audioCodec) {
            console.warn('No supported audio codec found, continuing without audio');
          } else {
            updateProgress('processing', `Adding audio track (${audioCodec})...`, 10);

            // Create audio source from the decoded audio buffer
            audioSource = new AudioBufferSource({
              codec: audioCodec,
              bitrate: 128000,
            });

            output.addAudioTrack(audioSource);
            pendingAudioBuffer = audioData.buffer;
          }
        }

        await output.start();

        // Track the highest timestamp we've written to ensure monotonicity
        // Start at -frameInterval so first frame can be at timestamp 0
        const frameInterval = 1 / outputFps;
        let highestWrittenTimestamp = -frameInterval;

        // Process each video blob
        for (let videoIndex = 0; videoIndex < videoBlobs.length; videoIndex++) {
          const videoBlob = videoBlobs[videoIndex];
          const videoNumber = videoIndex + 1;

          updateProgress(
            'processing',
            `Processing video ${videoNumber}/${videoBlobs.length}...`,
            5 + (videoIndex / videoBlobs.length) * 90,
            videoNumber
          );

          // Create input for this video
          const blobSource = new BlobSource(videoBlob);
          const input = new Input({
            source: blobSource,
            formats: ALL_FORMATS,
          });

          try {
            const videoTracks = await input.getVideoTracks();
            if (videoTracks.length === 0) {
              console.warn(`No video tracks in video ${videoNumber}`);
              continue;
            }

            const videoTrack = videoTracks[0];
            const sink = new VideoSampleSink(videoTrack);

            // Get duration of this video
            const videoDuration = await input.computeDuration();

            // Track the base offset for this video segment
            const segmentBaseTime = highestWrittenTimestamp;
            // Track minimum timestamp in this segment to normalize
            let segmentMinTimestamp: number | null = null;

            // Read and write samples from this video
            let samplesFromThisVideo = 0;
            for await (const sample of sink.samples(0, videoDuration)) {
              const originalTimestamp = sample.timestamp ?? 0;

              // On first sample, record the minimum timestamp to normalize from
              if (segmentMinTimestamp === null) {
                segmentMinTimestamp = originalTimestamp;
              }

              // Normalize timestamp relative to segment start, then offset by base time
              const normalizedTimestamp = originalTimestamp - segmentMinTimestamp;
              const adjustedTimestamp = segmentBaseTime + normalizedTimestamp;

              // Snap to 60fps grid for consistent framerate
              const snappedTimestamp = Math.round(adjustedTimestamp / frameInterval) * frameInterval;

              // Skip duplicate frames that land on the same timestamp slot
              // This ensures strict 60fps without exceeding the target rate
              if (snappedTimestamp <= highestWrittenTimestamp) {
                sample.close();
                continue;
              }

              sample.setTimestamp(snappedTimestamp);
              sample.setDuration(frameInterval);
              await videoSource.add(sample);

              // Update highest written timestamp
              highestWrittenTimestamp = snappedTimestamp;

              sample.close();
              samplesFromThisVideo++;

              // Update progress
              if (samplesFromThisVideo % 10 === 0) {
                const videoProgress = samplesFromThisVideo / 300; // Rough estimate
                const overallProgress =
                  5 + ((videoIndex + videoProgress) / videoBlobs.length) * 90;
                updateProgress(
                  'processing',
                  `Processing video ${videoNumber}/${videoBlobs.length}: ${samplesFromThisVideo} frames...`,
                  overallProgress,
                  videoNumber
                );
              }
            }
          } catch (videoError) {
            const errorMsg =
              videoError instanceof Error
                ? videoError.message
                : `Failed to process video ${videoNumber}`;
            console.error(`Error processing video ${videoNumber}:`, videoError);
            throw new Error(errorMsg);
          } finally {
            input.dispose();
          }
        }

        // Encode audio after all video frames have been queued so container metadata stays accurate
        if (audioSource && pendingAudioBuffer) {
          updateProgress('processing', 'Encoding audio track...', 92);
          await audioSource.add(pendingAudioBuffer);
          await audioSource.close();
        }

        // Flush encoder before finalizing container
        await videoSource.close();
        updateProgress('processing', 'Finalizing stitched video...', 97);

        // Finalize output
        await output.finalize();
        const buffer = bufferTarget.buffer;

        if (!buffer) {
          throw new Error('Failed to generate output buffer');
        }

        const outputBlob = new Blob([buffer], { type: 'video/mp4' });

        updateProgress(
          'complete',
          `Successfully stitched ${videoBlobs.length} videos into ${(outputBlob.size / 1024 / 1024).toFixed(2)}MB file`,
          100
        );

        return outputBlob;
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        console.error('Video stitching error:', normalizedError);

        const errorProgress: StitchProgress = {
          status: 'error',
          message: `Error: ${normalizedError.message}`,
          progress: 0,
          error: normalizedError.message,
        };

        setProgress(errorProgress);
        onProgress?.(errorProgress);

        throw normalizedError;
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
    stitchVideos,
    progress,
    reset,
  };
};
