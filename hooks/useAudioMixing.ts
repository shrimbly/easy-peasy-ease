'use client';

import { useCallback } from 'react';
import {
  Input,
  AudioBufferSink,
  BlobSource,
  ALL_FORMATS,
} from 'mediabunny';

const MINIMUM_AUDIO_DURATION = 0.1; // seconds

interface AudioMixProgress {
  message: string;
  progress: number; // 0-100
}

interface AudioData {
  buffer: AudioBuffer;
  duration: number;
}

interface UseAudioMixingReturn {
  prepareAudio: (
    audioBlob: Blob,
    videoDuration: number,
    onProgress?: (progress: AudioMixProgress) => void
  ) => Promise<AudioData | null>;
}

/**
 * Hook for preparing audio to be mixed with video
 * Decodes audio and returns the AudioBuffer for later use
 */
export const useAudioMixing = (): UseAudioMixingReturn => {
  const prepareAudio = useCallback(
    async (
      audioBlob: Blob,
      videoDuration: number,
      onProgress?: (progress: AudioMixProgress) => void
    ): Promise<AudioData | null> => {
      try {
        onProgress?.({ message: 'Loading audio file...', progress: 10 });

        // Create input from audio blob
        const blobSource = new BlobSource(audioBlob);
        const input = new Input({
          source: blobSource,
          formats: ALL_FORMATS,
        });

        onProgress?.({ message: 'Reading audio tracks...', progress: 20 });

        // Get audio tracks
        const audioTracks = await input.getAudioTracks();
        if (audioTracks.length === 0) {
          throw new Error('No audio tracks found in file');
        }

        const audioTrack = audioTracks[0];
        const sink = new AudioBufferSink(audioTrack);

        // Get audio duration
        const audioDuration = await input.computeDuration();

        onProgress?.({ message: 'Decoding audio...', progress: 30 });

        // Decode the entire audio stream into contiguous buffers
        const decodedBuffers: AudioBuffer[] = [];
        for await (const wrappedBuffer of sink.buffers(0, Math.max(videoDuration, audioDuration))) {
          if (wrappedBuffer?.buffer) {
            decodedBuffers.push(wrappedBuffer.buffer);
          }
        }

        if (decodedBuffers.length === 0) {
          throw new Error('Failed to decode audio');
        }

        const sampleRate = decodedBuffers[0].sampleRate;
        const channels = decodedBuffers[0].numberOfChannels;
        const availableSamples = decodedBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
        const availableDuration = availableSamples / sampleRate;
        const targetDuration = Math.max(
          MINIMUM_AUDIO_DURATION,
          videoDuration
        );
        const totalSamples = Math.max(1, Math.floor(targetDuration * sampleRate));

        const mergedBuffer = new AudioBuffer({
          length: totalSamples,
          numberOfChannels: channels,
          sampleRate,
        });

        let writeOffset = 0;
        for (const buffer of decodedBuffers) {
          const remainingSamples = totalSamples - writeOffset;
          if (remainingSamples <= 0) {
            break;
          }
          const writeLength = Math.min(buffer.length, remainingSamples);
          for (let channel = 0; channel < channels; channel++) {
            const channelData = buffer.getChannelData(channel).subarray(0, writeLength);
            mergedBuffer.getChannelData(channel).set(channelData, writeOffset);
          }
          writeOffset += writeLength;
        }

        // If we ran out of source samples before filling the target duration,
        // loop the audio to keep the timeline filled
        while (writeOffset < totalSamples && decodedBuffers.length > 0) {
          for (const buffer of decodedBuffers) {
            const remainingSamples = totalSamples - writeOffset;
            if (remainingSamples <= 0) {
              break;
            }
            const writeLength = Math.min(buffer.length, remainingSamples);
            for (let channel = 0; channel < channels; channel++) {
              const channelData = buffer.getChannelData(channel).subarray(0, writeLength);
              mergedBuffer.getChannelData(channel).set(channelData, writeOffset);
            }
            writeOffset += writeLength;
          }
        }

        onProgress?.({ message: 'Audio ready for mixing', progress: 95 });

        return {
          buffer: mergedBuffer,
          duration: totalSamples / sampleRate,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Audio mixing error:', error);
        throw new Error(`Failed to process audio: ${errorMessage}`);
      }
    },
    []
  );

  return { prepareAudio };
};
