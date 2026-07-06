'use client';

import { useState, useCallback } from 'react';
import {
  Input,
  Output,
  VideoSampleSink,
  VideoSampleSource,
  AudioBufferSource,
  BlobSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  ALL_FORMATS,
  BufferTarget,
  Mp4OutputFormat,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import type { Rotation, VideoCodec } from 'mediabunny';
import type { RenderQuality } from '@/lib/types';
import { MAX_OUTPUT_FPS, PREVIEW_FPS } from '@/lib/speed-curve-config';
import { buildEncodeTiers, type SourceVideoInfo } from '@/lib/encode-planner';
import { createTierEncodingConfig, selectSupportedTier } from '@/lib/video-encoding';
import { ensureAudioEncoders, audioBitrateForQuality } from '@/lib/audio-codec';
import { throwIfAborted, isAbortError } from '@/lib/abort-utils';

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

export interface StitchVideosOptions {
  onProgress?: (progress: StitchProgress) => void;
  audioData?: AudioData;
  quality?: RenderQuality;
  signal?: AbortSignal;
  /** Non-fatal problems worth telling the user about (e.g. audio dropped) */
  onWarning?: (message: string) => void;
}

interface UseStitchVideosReturn {
  stitchVideos: (videoBlobs: Blob[], options?: StitchVideosOptions) => Promise<Blob | null>;
  progress: StitchProgress;
  reset: () => void;
}

interface ClipProbe {
  codec: VideoCodec | null;
  codecParameterString: string | null;
  codedWidth: number;
  codedHeight: number;
  rotation: Rotation;
  firstTimestamp: number;
  endTimestamp: number;
  packetCount: number | null;
  bitrate: number | null;
}

const probeClip = async (blob: Blob): Promise<ClipProbe> => {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      throw new Error('No video track found while probing clip');
    }
    const [codec, codecParameterString, codedWidth, codedHeight, rotation, firstTimestamp, endTimestamp, stats] =
      await Promise.all([
        track.getCodec(),
        track.getCodecParameterString(),
        track.getCodedWidth(),
        track.getCodedHeight(),
        track.getRotation(),
        track.getFirstTimestamp().catch(() => 0),
        track.computeDuration(),
        track.computePacketStats().catch(() => null),
      ]);
    return {
      codec,
      codecParameterString,
      codedWidth,
      codedHeight,
      rotation,
      firstTimestamp,
      endTimestamp,
      packetCount: stats?.packetCount ?? null,
      bitrate:
        stats?.averageBitrate && Number.isFinite(stats.averageBitrate) ? stats.averageBitrate : null,
    };
  } finally {
    input.dispose();
  }
};

/** Clips can be concatenated without re-encoding when their streams match. */
const canPassThrough = (probes: ClipProbe[]): boolean => {
  if (probes.length === 0) return false;
  const first = probes[0];
  if (!first.codec || !first.codecParameterString) return false;
  return probes.every(
    (p) =>
      p.codec === first.codec &&
      p.codecParameterString === first.codecParameterString &&
      p.codedWidth === first.codedWidth &&
      p.codedHeight === first.codedHeight &&
      p.rotation === first.rotation
  );
};

/**
 * Hook for stitching multiple video clips into one MP4.
 *
 * Primary path: lossless packet passthrough. The clips produced by the
 * speed-curve stage are all encoded by us with an identical configuration,
 * so their packets can be copied straight into the output with shifted
 * timestamps — no decode, no re-encode, no second generation loss, and no
 * decoder edge-cases at clip boundaries. When clips are not stream-compatible
 * (mixed sources), we fall back to a capability-planned re-encode.
 */
export const useStitchVideos = (): UseStitchVideosReturn => {
  const [progress, setProgress] = useState<StitchProgress>({
    status: 'idle',
    message: 'Ready',
    progress: 0,
  });

  const stitchVideos = useCallback(
    async (videoBlobs: Blob[], options: StitchVideosOptions = {}): Promise<Blob | null> => {
      const { onProgress, audioData, quality = 'full', signal, onWarning } = options;
      const isPreview = quality === 'preview';

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

      try {
        if (videoBlobs.length === 0) {
          throw new Error('No videos to stitch');
        }
        updateProgress('processing', 'Analyzing clips...', 2);
        throwIfAborted(signal);

        const probes: ClipProbe[] = [];
        for (const blob of videoBlobs) {
          probes.push(await probeClip(blob));
          throwIfAborted(signal);
        }

        // Prepare the (optional) audio track up front so both paths share it.
        let audioSource: AudioBufferSource | undefined;
        let pendingAudioBuffer: AudioBuffer | null = null;
        if (audioData) {
          await ensureAudioEncoders();
          const audioBitrate = audioBitrateForQuality(quality);
          const audioCodec = await getFirstEncodableAudioCodec(['aac', 'mp3'], {
            numberOfChannels: audioData.buffer.numberOfChannels,
            sampleRate: audioData.buffer.sampleRate,
            bitrate: audioBitrate,
          });

          if (!audioCodec) {
            onWarning?.(
              'Your browser cannot encode AAC or MP3 audio, so the video was rendered without music.'
            );
          } else {
            audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: audioBitrate });
            pendingAudioBuffer = audioData.buffer;
          }
        }

        const bufferTarget = new BufferTarget();
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target: bufferTarget,
        });

        try {
          const passThrough = canPassThrough(probes);

          if (passThrough) {
            // ============ LOSSLESS PACKET PASSTHROUGH ============
            updateProgress('processing', 'Stitching without re-encoding...', 5);
            const videoSource = new EncodedVideoPacketSource(probes[0].codec as VideoCodec);
            output.addVideoTrack(videoSource, { rotation: probes[0].rotation });
            if (audioSource) output.addAudioTrack(audioSource);
            await output.start();

            let timelineOffset = 0;
            let sentDecoderConfig = false;
            const totalPackets =
              probes.reduce((sum, p) => sum + (p.packetCount ?? 0), 0) || null;
            let copiedPackets = 0;

            for (let clipIndex = 0; clipIndex < videoBlobs.length; clipIndex++) {
              const probe = probes[clipIndex];
              const clipNumber = clipIndex + 1;
              updateProgress(
                'processing',
                `Copying clip ${clipNumber}/${videoBlobs.length}...`,
                5 + (clipIndex / videoBlobs.length) * 85,
                clipNumber
              );

              const input = new Input({
                source: new BlobSource(videoBlobs[clipIndex]),
                formats: ALL_FORMATS,
              });
              try {
                const track = await input.getPrimaryVideoTrack();
                if (!track) throw new Error(`No video track in clip ${clipNumber}`);
                const packetSink = new EncodedPacketSink(track);
                const decoderConfig = sentDecoderConfig ? null : await track.getDecoderConfig();

                for await (const packet of packetSink.packets()) {
                  throwIfAborted(signal);
                  const shifted = packet.clone({
                    timestamp: packet.timestamp - probe.firstTimestamp + timelineOffset,
                  });
                  if (!sentDecoderConfig && decoderConfig) {
                    await videoSource.add(shifted, { decoderConfig });
                    sentDecoderConfig = true;
                  } else {
                    await videoSource.add(shifted);
                  }
                  copiedPackets++;
                  if (totalPackets && copiedPackets % 50 === 0) {
                    updateProgress(
                      'processing',
                      `Copying clip ${clipNumber}/${videoBlobs.length} (${copiedPackets}/${totalPackets} packets)...`,
                      5 + (copiedPackets / totalPackets) * 85,
                      clipNumber
                    );
                  }
                }
              } finally {
                input.dispose();
              }

              timelineOffset += probe.endTimestamp - probe.firstTimestamp;
            }
          } else {
            // ============ RE-ENCODE FALLBACK (mixed sources) ============
            updateProgress('processing', 'Clips differ; re-encoding to a common format...', 5);

            const maxWidth = Math.max(...probes.map((p) => p.codedWidth));
            const maxHeight = Math.max(...probes.map((p) => p.codedHeight));
            const maxBitrate = Math.max(0, ...probes.map((p) => p.bitrate ?? 0));
            const mixedDimensions = probes.some(
              (p) => p.codedWidth !== maxWidth || p.codedHeight !== maxHeight
            );
            const rotation = probes[0].rotation;
            if (probes.some((p) => p.rotation !== rotation)) {
              onWarning?.(
                'Clips have mixed rotation metadata; using the first clip’s rotation for the output.'
              );
            }

            const sourceInfo: SourceVideoInfo = {
              width: maxWidth,
              height: maxHeight,
              bitrate: maxBitrate > 0 ? maxBitrate : undefined,
            };
            const frameRates = isPreview ? [PREVIEW_FPS] : [MAX_OUTPUT_FPS, PREVIEW_FPS];
            const tiers = buildEncodeTiers(sourceInfo, quality, frameRates).map((tier) =>
              mixedDimensions ? { ...tier, needsResize: true } : tier
            );
            const tier = await selectSupportedTier(tiers);
            if (!tier) {
              throw new Error(
                'This device cannot encode H.264 video at any supported resolution. ' +
                  'Try a different browser (Chrome or Edge work best) or smaller source videos.'
              );
            }
            updateProgress(
              'processing',
              `Re-encoding at ${tier.label} (${tier.width}x${tier.height})...`,
              8
            );

            const videoSource = new VideoSampleSource(createTierEncodingConfig(tier));
            output.addVideoTrack(videoSource, { rotation });
            if (audioSource) output.addAudioTrack(audioSource);
            await output.start();

            const frameInterval = 1 / tier.frameRate;
            let highestWrittenTimestamp = -frameInterval;

            for (let clipIndex = 0; clipIndex < videoBlobs.length; clipIndex++) {
              const probe = probes[clipIndex];
              const clipNumber = clipIndex + 1;
              updateProgress(
                'processing',
                `Processing clip ${clipNumber}/${videoBlobs.length}...`,
                5 + (clipIndex / videoBlobs.length) * 85,
                clipNumber
              );

              const input = new Input({
                source: new BlobSource(videoBlobs[clipIndex]),
                formats: ALL_FORMATS,
              });
              try {
                const track = await input.getPrimaryVideoTrack();
                if (!track) {
                  onWarning?.(`Clip ${clipNumber} has no video track and was skipped.`);
                  continue;
                }
                const sink = new VideoSampleSink(track);

                // Each clip starts on the next free slot of the output frame
                // grid so its first frame is preserved (a previous version
                // started at the occupied last slot and silently dropped every
                // clip's first frame).
                const segmentBase = highestWrittenTimestamp + frameInterval;
                let isFirstSampleOfClip = true;
                let clipSampleCount = 0;

                for await (const sample of sink.samples(probe.firstTimestamp, probe.endTimestamp)) {
                  throwIfAborted(signal);
                  const normalized = sample.timestamp - probe.firstTimestamp;
                  const snapped =
                    Math.round((segmentBase + normalized) / frameInterval) * frameInterval;

                  // Duplicate frames landing on an occupied slot are skipped
                  // (sources faster than the output grid).
                  if (snapped <= highestWrittenTimestamp) {
                    sample.close();
                    continue;
                  }

                  sample.setTimestamp(snapped);
                  sample.setDuration(frameInterval);
                  if (isFirstSampleOfClip) {
                    // Key frame at every clip boundary: better seeking and no
                    // reliance on inter-frame prediction across the seam.
                    sample.setEncodeOptions({ keyFrame: true });
                    isFirstSampleOfClip = false;
                  }
                  await videoSource.add(sample);
                  highestWrittenTimestamp = snapped;
                  sample.close();
                  clipSampleCount++;

                  if (clipSampleCount % 10 === 0) {
                    const denominator = probe.packetCount ?? 300;
                    const clipProgress = Math.min(1, clipSampleCount / denominator);
                    updateProgress(
                      'processing',
                      `Processing clip ${clipNumber}/${videoBlobs.length}: ${clipSampleCount} frames...`,
                      5 + ((clipIndex + clipProgress) / videoBlobs.length) * 85,
                      clipNumber
                    );
                  }
                }
              } finally {
                input.dispose();
              }
            }

            await videoSource.close();
          }

          // Audio is encoded after all video so container metadata stays accurate.
          if (audioSource && pendingAudioBuffer) {
            updateProgress('processing', 'Encoding audio track...', 92);
            await audioSource.add(pendingAudioBuffer);
            await audioSource.close();
          }

          updateProgress('processing', 'Finalizing stitched video...', 97);
          await output.finalize();
        } catch (error) {
          await output.cancel().catch(() => {});
          throw error;
        }

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
        if (isAbortError(error)) {
          updateProgress('idle', 'Cancelled', 0);
          return null;
        }
        const normalizedError = error instanceof Error ? error : new Error(String(error));
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
    setProgress({ status: 'idle', message: 'Ready', progress: 0 });
  }, []);

  return { stitchVideos, progress, reset };
};
