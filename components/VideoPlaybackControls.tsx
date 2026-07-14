'use client';

import { ReactNode } from 'react';
import { Play, Pause } from 'lucide-react';
import { formatTime } from '@/lib/timeline-utils';
import { Button } from '@/components/ui/button';

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
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          onClick={onPlayPause}
          className="shrink-0"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <Pause className="size-6" />
          ) : (
            <Play className="ml-0.5 size-7" />
          )}
        </Button>

        <div className="flex items-center gap-3 md:gap-6 flex-1 min-w-0">
          <div className="whitespace-nowrap font-mono text-xs font-medium tabular-nums text-muted-foreground md:text-sm">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>

          {actions && <div className="flex items-center gap-2 md:gap-3 flex-1 justify-end min-w-0">{actions}</div>}
        </div>
      </div>
      
      {videoSize !== undefined && (
        <div className="hidden shrink-0 items-center gap-4 font-mono text-xs text-muted-foreground sm:flex">
          <span>Size: {(videoSize / 1024 / 1024).toFixed(2)}MB</span>
        </div>
      )}
    </div>
  );
}
