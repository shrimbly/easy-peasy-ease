import { useState, useEffect } from 'react';

export interface WaveformData {
  channelData: Float32Array[];
  sampleRate: number;
  duration: number;
  peaks: number[];
}

/**
 * Hook to extract waveform visualization data from an audio file
 */
const waveformCache = new Map<string, WaveformData>();
const blobKeyStore = new WeakMap<Blob, string>();
let blobKeyCounter = 0;
let sharedAudioContext: AudioContext | null = null;

const getBlobCacheKey = (audioFile: File | Blob | null) => {
  if (!audioFile) return null;
  if (audioFile instanceof File) {
    return `${audioFile.name}-${audioFile.size}-${audioFile.lastModified}`;
  }
  const existing = blobKeyStore.get(audioFile);
  if (existing) return existing;
  const generated = `blob-${blobKeyCounter++}-${audioFile.size}-${audioFile.type ?? 'unknown'}`;
  blobKeyStore.set(audioFile, generated);
  return generated;
};

const getSharedAudioContext = () => {
  if (sharedAudioContext) {
    return sharedAudioContext;
  }
  const AudioCtor =
    typeof window !== 'undefined'
      ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : null;
  if (!AudioCtor) {
    throw new Error('AudioContext is not supported in this environment');
  }
  sharedAudioContext = new AudioCtor();
  return sharedAudioContext;
};

const decodeAudioBuffer = async (context: AudioContext, arrayBuffer: ArrayBuffer) => {
  if ('decodeAudioData' in context && context.decodeAudioData.length === 1) {
    return context.decodeAudioData(arrayBuffer);
  }
  return new Promise<AudioBuffer>((resolve, reject) => {
    context.decodeAudioData(arrayBuffer, resolve, reject);
  });
};

export function useAudioVisualization(audioFile: File | Blob | null) {
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!audioFile) {
      setWaveformData(null);
      setError(null);
       setIsLoading(false);
      return;
    }

    const cacheKey = getBlobCacheKey(audioFile);
    if (cacheKey && waveformCache.has(cacheKey)) {
      setWaveformData(waveformCache.get(cacheKey)!);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isCancelled = false;

    const processAudio = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Read file as array buffer
        const arrayBuffer = await audioFile.arrayBuffer();

        // Decode audio
        const audioContext = getSharedAudioContext();
        const audioBuffer = await decodeAudioBuffer(audioContext, arrayBuffer);

        // Extract channel data
        const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) =>
          audioBuffer.getChannelData(i)
        );

        // Calculate peaks for visualization (downsample for performance)
        const peaks = calculatePeaks(channelData, 256);

        const nextWaveform: WaveformData = {
          channelData,
          sampleRate: audioBuffer.sampleRate,
          duration: audioBuffer.duration,
          peaks,
        };

        if (cacheKey) {
          waveformCache.set(cacheKey, nextWaveform);
        }

        if (!isCancelled) {
          setWaveformData(nextWaveform);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to process audio';
        setError(message);
        console.error('Audio processing error:', err);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    processAudio();

    return () => {
      isCancelled = true;
    };
  }, [audioFile]);

  return { waveformData, isLoading, error };
}

/**
 * Calculate peaks from audio channel data for efficient visualization
 */
function calculatePeaks(channelData: Float32Array[], resolution: number): number[] {
  const peaks: number[] = [];
  const totalSamples = channelData[0]?.length ?? 0;
  const samplesPerPeak = Math.max(1, Math.floor(totalSamples / resolution));

  for (let i = 0; i < resolution; i++) {
    let max = 0;
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, totalSamples);

    // Get max amplitude across all channels for this peak
    for (const channel of channelData) {
      for (let j = start; j < end; j++) {
        max = Math.max(max, Math.abs(channel[j] ?? 0));
      }
    }

    peaks.push(max);
  }

  return peaks;
}
