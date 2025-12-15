'use client';

import { useCallback } from 'react';
import { AudioProcessingOptions } from '@/lib/types';
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
    onProgress?: (progress: AudioMixProgress) => void,
    options?: AudioProcessingOptions
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
      onProgress?: (progress: AudioMixProgress) => void,
      options?: AudioProcessingOptions
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

        // Handle audio offset
        const offsetSeconds = options?.offset ?? 0;
        const offsetSamples = Math.floor(offsetSeconds * sampleRate);

        // Calculate where to start writing audio and where to start reading from source
        let writeOffset = 0;
        let sourceSkipSamples = 0;

        if (offsetSamples > 0) {
          // Positive offset: delay audio (start with silence)
          // The buffer is already zero-initialized, so we just start writing later
          writeOffset = Math.min(offsetSamples, totalSamples);
        } else if (offsetSamples < 0) {
          // Negative offset: trim beginning of audio (skip source samples)
          sourceSkipSamples = Math.abs(offsetSamples);
        }

        // Skip samples from source if needed (negative offset)
        let samplesToSkip = sourceSkipSamples;
        let bufferIndex = 0;
        let bufferOffset = 0;

        while (samplesToSkip > 0 && bufferIndex < decodedBuffers.length) {
          const buffer = decodedBuffers[bufferIndex];
          const availableInBuffer = buffer.length - bufferOffset;
          if (samplesToSkip >= availableInBuffer) {
            samplesToSkip -= availableInBuffer;
            bufferIndex++;
            bufferOffset = 0;
          } else {
            bufferOffset = samplesToSkip;
            samplesToSkip = 0;
          }
        }

        // Write audio from the current position in decoded buffers
        while (writeOffset < totalSamples && bufferIndex < decodedBuffers.length) {
          const buffer = decodedBuffers[bufferIndex];
          const remainingSamples = totalSamples - writeOffset;
          const availableInBuffer = buffer.length - bufferOffset;
          const writeLength = Math.min(availableInBuffer, remainingSamples);

          for (let channel = 0; channel < channels; channel++) {
            const channelData = buffer.getChannelData(channel).subarray(bufferOffset, bufferOffset + writeLength);
            mergedBuffer.getChannelData(channel).set(channelData, writeOffset);
          }

          writeOffset += writeLength;
          bufferOffset += writeLength;

          if (bufferOffset >= buffer.length) {
            bufferIndex++;
            bufferOffset = 0;
          }
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

        applyFades(mergedBuffer, options);

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

function applyFades(buffer: AudioBuffer, options?: AudioProcessingOptions) {
  if (!options) {
    return;
  }

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
