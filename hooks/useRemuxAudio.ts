'use client';

import { useCallback } from 'react';
import { AudioProcessingOptions } from '@/lib/types';
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
import type { VideoCodec, Rotation } from 'mediabunny';

interface RemuxProgress {
  message: string;
  progress: number; // 0-100
}

interface UseRemuxAudioReturn {
  remuxWithNewAudio: (
    finalVideoBlob: Blob,
    audioBlob: Blob,
    audioSettings: AudioProcessingOptions,
    onProgress?: (progress: RemuxProgress) => void
  ) => Promise<Blob | null>;
}

/**
 * Apply fade in/out to an AudioBuffer in place
 */
function applyFades(buffer: AudioBuffer, options: AudioProcessingOptions) {
  const fadeInSeconds = Math.max(0, options.fadeIn ?? 0);
  const fadeOutSeconds = Math.max(0, options.fadeOut ?? 0);
  if (fadeInSeconds === 0 && fadeOutSeconds === 0) {
    return;
  }

  const totalSamples = buffer.length;
  if (totalSamples === 0) {
    return;
  }

  let fadeInSamples = Math.min(totalSamples, Math.floor(fadeInSeconds * buffer.sampleRate));
  let fadeOutSamples = Math.min(totalSamples, Math.floor(fadeOutSeconds * buffer.sampleRate));

  if (fadeInSamples + fadeOutSamples > totalSamples) {
    const scale = totalSamples / Math.max(1, fadeInSamples + fadeOutSamples);
    fadeInSamples = Math.floor(fadeInSamples * scale);
    fadeOutSamples = Math.floor(fadeOutSamples * scale);
  }

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const channelData = buffer.getChannelData(channel);

    if (fadeInSamples > 0) {
      for (let i = 0; i < fadeInSamples; i++) {
        const gain = i / fadeInSamples;
        channelData[i] *= gain;
      }
    }

    if (fadeOutSamples > 0) {
      for (let i = 0; i < fadeOutSamples; i++) {
        const sampleIndex = totalSamples - fadeOutSamples + i;
        if (sampleIndex < 0 || sampleIndex >= totalSamples) {
          continue;
        }
        const gain = (fadeOutSamples - i) / fadeOutSamples;
        channelData[sampleIndex] *= gain;
      }
    }
  }
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
      onProgress?: (progress: RemuxProgress) => void
    ): Promise<Blob | null> => {
      let videoInput: Input | null = null;
      let audioInput: Input | null = null;

      try {
        onProgress?.({ message: 'Analyzing video...', progress: 5 });

        // Open the final video to read encoded video packets
        videoInput = new Input({
          source: new BlobSource(finalVideoBlob),
          formats: ALL_FORMATS,
        });

        const videoTracks = await videoInput.getVideoTracks();
        if (videoTracks.length === 0) {
          throw new Error('No video tracks found in source video');
        }

        const videoTrack = videoTracks[0];
        const videoDuration = await videoInput.computeDuration();

        // Get video codec and metadata
        const codecString = await videoTrack.getCodecParameterString();
        if (!codecString) {
          throw new Error('Could not determine video codec');
        }

        // Determine the base codec (avc, hevc, vp9, etc.)
        let videoCodec: VideoCodec;
        if (codecString.startsWith('avc')) {
          videoCodec = 'avc';
        } else if (codecString.startsWith('hvc') || codecString.startsWith('hev')) {
          videoCodec = 'hevc';
        } else if (codecString.startsWith('vp09')) {
          videoCodec = 'vp9';
        } else if (codecString.startsWith('vp8')) {
          videoCodec = 'vp8';
        } else if (codecString.startsWith('av01')) {
          videoCodec = 'av1';
        } else {
          // Default to avc if unknown
          videoCodec = 'avc';
        }

        const rotation: Rotation = (videoTrack.rotation === 0 || videoTrack.rotation === 90 ||
          videoTrack.rotation === 180 || videoTrack.rotation === 270)
          ? videoTrack.rotation : 0;

        onProgress?.({ message: 'Decoding audio...', progress: 15 });

        // Decode audio from the audio blob
        audioInput = new Input({
          source: new BlobSource(audioBlob),
          formats: ALL_FORMATS,
        });

        const audioTracks = await audioInput.getAudioTracks();
        if (audioTracks.length === 0) {
          throw new Error('No audio tracks found in audio file');
        }

        const audioTrack = audioTracks[0];
        const audioSink = new AudioBufferSink(audioTrack);

        // Decode audio
        const decodedBuffers: AudioBuffer[] = [];
        for await (const wrappedBuffer of audioSink.buffers(0, videoDuration)) {
          if (wrappedBuffer?.buffer) {
            decodedBuffers.push(wrappedBuffer.buffer);
          }
        }

        if (decodedBuffers.length === 0) {
          throw new Error('Failed to decode audio');
        }

        onProgress?.({ message: 'Processing audio...', progress: 30 });

        // Merge decoded buffers and apply fades
        const sampleRate = decodedBuffers[0].sampleRate;
        const channels = decodedBuffers[0].numberOfChannels;
        const totalSamples = Math.max(1, Math.floor(videoDuration * sampleRate));

        const mergedBuffer = new AudioBuffer({
          length: totalSamples,
          numberOfChannels: channels,
          sampleRate,
        });

        // Copy decoded audio to merged buffer
        let writeOffset = 0;
        for (const buffer of decodedBuffers) {
          const remainingSamples = totalSamples - writeOffset;
          if (remainingSamples <= 0) break;

          const writeLength = Math.min(buffer.length, remainingSamples);
          for (let channel = 0; channel < channels; channel++) {
            const channelData = buffer.getChannelData(channel).subarray(0, writeLength);
            mergedBuffer.getChannelData(channel).set(channelData, writeOffset);
          }
          writeOffset += writeLength;
        }

        // Loop audio if needed to fill video duration
        while (writeOffset < totalSamples && decodedBuffers.length > 0) {
          for (const buffer of decodedBuffers) {
            const remainingSamples = totalSamples - writeOffset;
            if (remainingSamples <= 0) break;

            const writeLength = Math.min(buffer.length, remainingSamples);
            for (let channel = 0; channel < channels; channel++) {
              const channelData = buffer.getChannelData(channel).subarray(0, writeLength);
              mergedBuffer.getChannelData(channel).set(channelData, writeOffset);
            }
            writeOffset += writeLength;
          }
        }

        // Apply fade in/out
        applyFades(mergedBuffer, audioSettings);

        onProgress?.({ message: 'Creating output...', progress: 40 });

        // Create output with passthrough video source
        const videoSource = new EncodedVideoPacketSource(videoCodec);

        // Detect best audio codec
        const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus', 'mp3'], {
          numberOfChannels: channels,
          sampleRate,
          bitrate: 128000,
        });

        if (!audioCodec) {
          throw new Error('No supported audio codec found');
        }

        const audioSource = new AudioBufferSource({
          codec: audioCodec,
          bitrate: 128000,
        });

        const bufferTarget = new BufferTarget();
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target: bufferTarget,
        });

        output.addVideoTrack(videoSource, { rotation });
        output.addAudioTrack(audioSource);
        await output.start();

        onProgress?.({ message: 'Copying video packets...', progress: 50 });

        // Create packet sink to read encoded video packets
        const packetSink = new EncodedPacketSink(videoTrack);

        // Copy all video packets directly (no re-encoding)
        let packetCount = 0;
        let isFirstPacket = true;

        // Get decoder config from track for first packet metadata
        const trackConfig = await videoTrack.getDecoderConfig();

        for await (const packet of packetSink.packets()) {
          // Pass decoder config with first packet
          if (isFirstPacket && trackConfig) {
            await videoSource.add(packet, { decoderConfig: trackConfig });
            isFirstPacket = false;
          } else {
            await videoSource.add(packet);
          }

          packetCount++;

          // Update progress periodically
          if (packetCount % 30 === 0) {
            const progressValue = 50 + (packetCount / 300) * 30; // Rough estimate
            onProgress?.({
              message: `Copying video packets... (${packetCount})`,
              progress: Math.min(80, progressValue)
            });
          }
        }

        onProgress?.({ message: 'Encoding audio...', progress: 85 });

        // Add processed audio
        await audioSource.add(mergedBuffer);
        await audioSource.close();
        await videoSource.close();

        onProgress?.({ message: 'Finalizing...', progress: 95 });

        // Finalize output
        await output.finalize();
        const buffer = bufferTarget.buffer;

        if (!buffer) {
          throw new Error('Failed to generate output buffer');
        }

        const outputBlob = new Blob([buffer], { type: 'video/mp4' });

        onProgress?.({
          message: `Audio updated (${(outputBlob.size / 1024 / 1024).toFixed(2)}MB)`,
          progress: 100
        });

        return outputBlob;
      } catch (error) {
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
