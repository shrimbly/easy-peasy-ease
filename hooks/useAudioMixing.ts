'use client';

import { useCallback } from 'react';
import { AudioProcessingOptions } from '@/lib/types';
import {
  Input,
  AudioBufferSink,
  BlobSource,
  ALL_FORMATS,
} from 'mediabunny';
import { assembleAudio } from '@/lib/audio-prep';

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
 * Hook for preparing audio to be mixed with video.
 * Decodes only the range of audio the video needs, then assembles it
 * (offset/loop/downmix/fades) via the shared lib/audio-prep implementation.
 */
export const useAudioMixing = (): UseAudioMixingReturn => {
  const prepareAudio = useCallback(
    async (
      audioBlob: Blob,
      videoDuration: number,
      onProgress?: (progress: AudioMixProgress) => void,
      options?: AudioProcessingOptions
    ): Promise<AudioData | null> => {
      const input = new Input({
        source: new BlobSource(audioBlob),
        formats: ALL_FORMATS,
      });
      try {
        onProgress?.({ message: 'Loading audio file...', progress: 10 });

        const audioTrack = await input.getPrimaryAudioTrack();
        if (!audioTrack) {
          throw new Error('No audio tracks found in file');
        }

        const sink = new AudioBufferSink(audioTrack);

        onProgress?.({ message: 'Decoding audio...', progress: 30 });

        // Decode only what the timeline can use: the video's duration plus
        // any part trimmed from the start by a negative offset. (Shorter
        // songs simply stop decoding at their end and are looped later.)
        const offsetSeconds = options?.offset ?? 0;
        const neededDuration = videoDuration + Math.max(0, -offsetSeconds);

        const decodedBuffers: AudioBuffer[] = [];
        for await (const wrappedBuffer of sink.buffers(0, neededDuration)) {
          if (wrappedBuffer?.buffer) {
            decodedBuffers.push(wrappedBuffer.buffer);
          }
        }

        if (decodedBuffers.length === 0) {
          throw new Error('Failed to decode audio');
        }

        onProgress?.({ message: 'Assembling audio track...', progress: 70 });

        const merged = assembleAudio(decodedBuffers, videoDuration, {
          offset: offsetSeconds,
          fadeIn: options?.fadeIn,
          fadeOut: options?.fadeOut,
        });

        if (!merged) {
          throw new Error('Audio file contains no audio data');
        }

        onProgress?.({ message: 'Audio ready for mixing', progress: 95 });

        return {
          buffer: merged as AudioBuffer,
          duration: merged.length / merged.sampleRate,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Audio mixing error:', error);
        throw new Error(`Failed to process audio: ${errorMessage}`);
      } finally {
        input.dispose();
      }
    },
    []
  );

  return { prepareAudio };
};
