'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { WaveformData } from '@/hooks/useAudioVisualization';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AudioWaveformVisualizationProps {
  waveformData: WaveformData | null;
  fileName?: string;
  isLoading?: boolean;
  onRemove?: () => void;
  currentTime?: number;
  duration?: number;
  onSelect?: () => void;
  isSelected?: boolean;
  trackWidth?: number;
}

export function AudioWaveformVisualization({
  waveformData,
  fileName = 'Audio Track',
  isLoading = false,
  onRemove,
  currentTime = 0,
  duration = 0,
  onSelect,
  isSelected = false,
  trackWidth,
}: AudioWaveformVisualizationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !waveformData) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Get theme color (primary color from CSS variable)
    const primaryColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--primary')
      .trim() || 'hsl(262.1 83.3% 57.8%)';

    const width = rect.width;
    const height = rect.height;

    // Clear canvas with transparent background
    ctx.clearRect(0, 0, width, height);

    // Draw waveform
    const peaks = waveformData.peaks;
    const barWidth = width / peaks.length;

    ctx.fillStyle = primaryColor;

    for (let i = 0; i < peaks.length; i++) {
      const peak = peaks[i] ?? 0;
      const barHeight = (peak * height) / 2;
      const x = i * barWidth;
      const y = height / 2 - barHeight / 2;

      ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
    }

    // Draw playback position indicator
    if (duration > 0 && currentTime >= 0) {
      const progressX = (currentTime / duration) * width;
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(progressX, 0);
      ctx.lineTo(progressX, height);
      ctx.stroke();
    }
  }, [waveformData, currentTime, duration, trackWidth]);

  if (!waveformData) {
    return null;
  }

  const handleSelect = () => {
    onSelect?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      className="w-full space-y-2"
      style={trackWidth ? { width: `${trackWidth}px` } : undefined}
    >
      <div
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={handleSelect}
        onKeyDown={handleKeyDown}
        className={cn(
          'relative rounded-lg border border-border bg-secondary/20 overflow-hidden transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          onSelect && 'cursor-pointer',
          isSelected && 'border-primary ring-2 ring-primary shadow-lg'
        )}
        aria-pressed={isSelected}
      >
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            disabled={isLoading}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        <canvas
          ref={canvasRef}
          className="h-[96px] w-full bg-secondary/50"
          aria-label={`${fileName} waveform`}
        />
      </div>
    </div>
  );
}
