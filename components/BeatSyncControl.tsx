'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BEAT_SUBDIVISIONS, type BeatSubdivision } from '@/lib/beat-sync';

interface BeatSyncControlProps {
  bpm: number;
  /** Seconds per beat — drives the pulse dot's animation tempo. */
  period: number;
  /** Active snap subdivision; 0 = off. */
  value: BeatSubdivision | 0;
  onValueChange: (value: BeatSubdivision | 0) => void;
  /** Re-render CTA, shown while a subdivision is active. */
  onApply?: () => void;
  isUpdating?: boolean;
  className?: string;
}

const subdivisionLabel = (subdivision: BeatSubdivision) =>
  subdivision === 1 ? 'Every beat' : subdivision === 2 ? 'Every 2nd beat' : 'Every 4th beat';

/**
 * Compact beat-snap pill: pulsing tempo dot + BPM readout + 1/2/4 toggles.
 * Overlaid on the audio track, so it swallows pointer events (the track
 * underneath starts an offset drag on pointerdown and selects on click).
 */
export function BeatSyncControl({
  bpm,
  period,
  value,
  onValueChange,
  onApply,
  isUpdating = false,
  className,
}: BeatSyncControlProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-md border border-border/70 bg-background/85 px-1.5 py-1 shadow-sm backdrop-blur-sm',
        className
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="flex items-center gap-1.5 pl-1 pr-1.5" aria-label={`${Math.round(bpm)} beats per minute`}>
        <span
          aria-hidden
          className="beat-pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
          style={{ animation: `beat-pulse ${period}s ease-out infinite` }}
        />
        <span className="text-[11px] font-semibold tabular-nums leading-none text-foreground">
          {Math.round(bpm)}
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-wide leading-none text-muted-foreground">
          bpm
        </span>
      </span>

      <div className="h-4 w-px bg-border" aria-hidden />

      <div role="group" aria-label="Snap section lengths to beats" className="flex items-center gap-0.5">
        {BEAT_SUBDIVISIONS.map((subdivision) => {
          const active = value === subdivision;
          return (
            <button
              key={subdivision}
              type="button"
              aria-pressed={active}
              aria-label={subdivisionLabel(subdivision)}
              title={subdivisionLabel(subdivision)}
              onClick={() => onValueChange(active ? 0 : subdivision)}
              className={cn(
                'h-6 min-w-6 rounded-sm px-1 text-[11px] font-semibold tabular-nums transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary/80 hover:text-foreground'
              )}
            >
              {subdivision}
            </button>
          );
        })}
      </div>

      {value !== 0 && onApply && (
        <>
          <div className="h-4 w-px bg-border" aria-hidden />
          <button
            type="button"
            aria-label="Update video with beat-synced sections"
            title="Update video"
            onClick={onApply}
            disabled={isUpdating}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-primary transition-colors hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-50"
          >
            {isUpdating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </>
      )}
    </div>
  );
}
