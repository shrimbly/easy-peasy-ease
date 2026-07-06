'use client';

import { useCallback } from 'react';
import { AudioProcessingOptions, RenderQuality } from '@/lib/types';
import {
  Input,
  Output,
  AudioBufferSink,
  AudioBufferSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  BlobSource,
  ALL_FORMATS,
  BufferTarget,
  Mp4OutputFormat,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import { assembleAudio } from '@/lib/audio-prep';
import { ensureAudioEncoders, audioBitrateForQuality } from '@/lib/audio-codec';
import { throwIfAborted, isAbortError } from '@/lib/abort-utils';

interface RemuxProgress {
  message: string;
  progress: number; // 0-100
}

export interface RemuxAudioOptions {
  quality?: RenderQuality;
  signal?: AbortSignal;
  onProgress?: (progress: RemuxProgress) => void;
}

interface UseRemuxAudioReturn {
  remuxWithNewAudio: (
    finalVideoBlob: Blob,
    audioBlob: Blob,
    audioSettings: AudioProcessingOptions,
    options?: RemuxAudioOptions
  ) => Promise<Blob | null>;
}

/**
 * Hook for remuxing video with new audio without re-encoding the video track.
 * Uses encoded packet passthrough for video to achieve fast audio-only updates.
 */
export const useRemuxAudio = (): UseRemuxAudioReturn => {
  const remuxWithNewAudio = useCallback(
    async (
      finalVideoBlob: Blob,
      audioBlob: Blob,
      audioSettings: AudioProcessingOptions,
      options: RemuxAudioOptions = {}
    ): Promise<Blob | null> => {
      const { quality = 'full', signal, onProgress } = options;
      let videoInput: Input | null = null;
      let audioInput: Input | null = null;

      try {
        onProgress?.({ message: 'Analyzing video...', progress: 5 });
        throwIfAborted(signal);

        // Open the final video to read encoded video packets
        videoInput = new Input({
          source: new BlobSource(finalVideoBlob),
          formats: ALL_FORMATS,
        });

        const videoTrack = await videoInput.getPrimaryVideoTrack();
        if (!videoTrack) {
          throw new Error('No video tracks found in source video');
        }

        const [videoCodec, rotation, videoDuration] = await Promise.all([
          videoTrack.getCodec(),
          videoTrack.getRotation(),
          videoInput.computeDuration(),
        ]);
        if (!videoCodec) {
          throw new Error('Could not determine video codec');
        }

        onProgress?.({ message: 'Decoding audio...', progress: 15 });

        // Decode audio from the audio blob — only the range the video needs.
        audioInput = new Input({
          source: new BlobSource(audioBlob),
          formats: ALL_FORMATS,
        });

        const audioTrack = await audioInput.getPrimaryAudioTrack();
        if (!audioTrack) {
          throw new Error('No audio tracks found in audio file');
        }

        const audioSink = new AudioBufferSink(audioTrack);
        const neededDuration = videoDuration + Math.max(0, -(audioSettings.offset ?? 0));

        const decodedBuffers: AudioBuffer[] = [];
        for await (const wrappedBuffer of audioSink.buffers(0, neededDuration)) {
          if (wrappedBuffer?.buffer) {
            decodedBuffers.push(wrappedBuffer.buffer);
          }
          throwIfAborted(signal);
        }

        if (decodedBuffers.length === 0) {
          throw new Error('Failed to decode audio');
        }

        onProgress?.({ message: 'Processing audio...', progress: 30 });

        // Offset + loop + downmix + fades — same implementation as the full
        // render path, so fast audio updates behave identically.
        const mergedBuffer = assembleAudio(decodedBuffers, videoDuration, {
          offset: audioSettings.offset,
          fadeIn: audioSettings.fadeIn,
          fadeOut: audioSettings.fadeOut,
        });
        if (!mergedBuffer) {
          throw new Error('Audio file contains no audio data');
        }

        onProgress?.({ message: 'Creating output...', progress: 40 });

        // Create output with passthrough video source
        const videoSource = new EncodedVideoPacketSource(videoCodec);

        await ensureAudioEncoders();
        const audioBitrate = audioBitrateForQuality(quality);
        const audioCodec = await getFirstEncodableAudioCodec(['aac', 'mp3'], {
          numberOfChannels: mergedBuffer.numberOfChannels,
          sampleRate: mergedBuffer.sampleRate,
          bitrate: audioBitrate,
        });

        if (!audioCodec) {
          throw new Error('No supported audio codec found');
        }

        const audioSource = new AudioBufferSource({
          codec: audioCodec,
          bitrate: audioBitrate,
        });

        const bufferTarget = new BufferTarget();
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target: bufferTarget,
        });

        output.addVideoTrack(videoSource, { rotation });
        output.addAudioTrack(audioSource);

        try {
          await output.start();

          onProgress?.({ message: 'Copying video packets...', progress: 50 });

          const packetSink = new EncodedPacketSink(videoTrack);
          const trackConfig = await videoTrack.getDecoderConfig();
          const packetStats = await videoTrack.computePacketStats().catch(() => null);
          const totalPackets = packetStats?.packetCount ?? null;

          let packetCount = 0;
          let isFirstPacket = true;

          for await (const packet of packetSink.packets()) {
            throwIfAborted(signal);
            if (isFirstPacket && trackConfig) {
              await videoSource.add(packet, { decoderConfig: trackConfig });
              isFirstPacket = false;
            } else {
              await videoSource.add(packet);
            }

            packetCount++;
            if (packetCount % 30 === 0) {
              const progressValue = totalPackets
                ? 50 + (packetCount / totalPackets) * 30
                : Math.min(80, 50 + (packetCount / 300) * 30);
              onProgress?.({
                message: `Copying video packets... (${packetCount})`,
                progress: Math.min(80, progressValue),
              });
            }
          }

          onProgress?.({ message: 'Encoding audio...', progress: 85 });

          await audioSource.add(mergedBuffer as AudioBuffer);
          await audioSource.close();
          await videoSource.close();

          onProgress?.({ message: 'Finalizing...', progress: 95 });
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

        onProgress?.({
          message: `Audio updated (${(outputBlob.size / 1024 / 1024).toFixed(2)}MB)`,
          progress: 100,
        });

        return outputBlob;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Remux error:', error);
        throw new Error(`Failed to remux audio: ${errorMessage}`);
      } finally {
        videoInput?.dispose();
        audioInput?.dispose();
      }
    },
    []
  );

  return { remuxWithNewAudio };
};
