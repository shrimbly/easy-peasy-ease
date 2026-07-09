'use client';

import { ReactNode } from 'react';
import { Play, Pause } from 'lucide-react';
import { formatTime } from '@/lib/timeline-utils';

interface VideoPlaybackControlsProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlayPause: () => void;
  videoSize?: number;
  actions?: ReactNode;
}

export function VideoPlaybackControls({
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  videoSize,
  actions,
}: VideoPlaybackControlsProps) {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 md:gap-4">
      <div className="flex items-center gap-2 md:gap-4 flex-1 min-w-0">
        <button
          onClick={onPlayPause}
          className="p-0 shrink-0 hover:opacity-70 transition-opacity"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <Pause className="h-5 w-5 md:h-6 md:w-6" />
          ) : (
            <Play className="h-5 w-5 md:h-6 md:w-6 ml-0.5" />
          )}
        </button>

        <div className="flex items-center gap-3 md:gap-6 flex-1 min-w-0">
          <div className="text-xs md:text-sm font-medium text-muted-foreground tabular-nums whitespace-nowrap">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>

          {actions && <div className="flex items-center gap-2 md:gap-3 flex-1 justify-end min-w-0">{actions}</div>}
        </div>
      </div>
      
      {videoSize !== undefined && (
        <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground shrink-0">
          <span>Size: {(videoSize / 1024 / 1024).toFixed(2)}MB</span>
        </div>
      )}
    </div>
  );
}
