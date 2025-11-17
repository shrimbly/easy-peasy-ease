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
export function useAudioVisualization(audioFile: File | Blob | null) {
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!audioFile) {
      setWaveformData(null);
      setError(null);
      return;
    }

    const processAudio = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Read file as array buffer
        const arrayBuffer = await audioFile.arrayBuffer();

        // Decode audio
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        // Extract channel data
        const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) =>
          audioBuffer.getChannelData(i)
        );

        // Calculate peaks for visualization (downsample for performance)
        const peaks = calculatePeaks(channelData, 256);

        setWaveformData({
          channelData,
          sampleRate: audioBuffer.sampleRate,
          duration: audioBuffer.duration,
          peaks,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to process audio';
        setError(message);
        console.error('Audio processing error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    processAudio();
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
