'use client';

import { type KeyboardEvent, useState, useRef, useEffect, useCallback } from 'react';
import { WaveformData } from '@/hooks/useAudioVisualization';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AudioScrubber } from '@/components/ui/waveform';

interface AudioWaveformVisualizationProps {
  waveformData: WaveformData | null;
  fileName?: string;
  isLoading?: boolean;
  onRemove?: () => void;
  currentTime?: number;
  timelineDuration: number;
  onSelect?: () => void;
  isSelected?: boolean;
  trackWidth: number;
  pixelsPerSecond: number;
  offset?: number;
  onOffsetChange?: (offset: number) => void;
  onOffsetCommit?: () => void;
}

export function AudioWaveformVisualization({
  waveformData,
  fileName = 'Audio Track',
  isLoading = false,
  onRemove,
  currentTime = 0,
  timelineDuration,
  onSelect,
  isSelected = false,
  trackWidth,
  pixelsPerSecond,
  offset = 0,
  onOffsetChange,
  onOffsetCommit,
}: AudioWaveformVisualizationProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [localOffset, setLocalOffset] = useState<number | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartOffsetRef = useRef(0);
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  const onOffsetChangeRef = useRef(onOffsetChange);
  const onOffsetCommitRef = useRef(onOffsetCommit);
  const localOffsetRef = useRef<number | null>(null);

  // Use local offset during drag, otherwise use prop
  const effectiveOffset = localOffset ?? offset;

  // Keep refs updated
  useEffect(() => {
    pixelsPerSecondRef.current = pixelsPerSecond;
  }, [pixelsPerSecond]);

  useEffect(() => {
    onOffsetChangeRef.current = onOffsetChange;
  }, [onOffsetChange]);

  useEffect(() => {
    onOffsetCommitRef.current = onOffsetCommit;
  }, [onOffsetCommit]);

  useEffect(() => {
    localOffsetRef.current = localOffset;
  }, [localOffset]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!onOffsetChangeRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer for reliable drag tracking
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    setIsDragging(true);
    dragStartXRef.current = e.clientX;
    dragStartOffsetRef.current = offset;
    pixelsPerSecondRef.current = pixelsPerSecond;
    setLocalOffset(offset); // Initialize local offset
  }, [offset, pixelsPerSecond]);

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const deltaX = e.clientX - dragStartXRef.current;
      const pps = pixelsPerSecondRef.current;
      if (pps <= 0) return;
      const deltaSeconds = deltaX / pps;
      const rawOffset = dragStartOffsetRef.current + deltaSeconds;
      // Snap to 0.01 second increments for fine control
      const newOffset = Math.round(rawOffset * 100) / 100;
      setLocalOffset(newOffset); // Update local state only during drag
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      const finalOffset = localOffsetRef.current;
      if (finalOffset !== null && finalOffset !== dragStartOffsetRef.current) {
        onOffsetChangeRef.current?.(finalOffset); // Commit final value to parent
        onOffsetCommitRef.current?.();
      }
      setLocalOffset(null); // Clear local state
    };

    window.addEventListener('pointermove', handlePointerMove, { capture: true });
    window.addEventListener('pointerup', handlePointerUp, { capture: true });
    window.addEventListener('pointercancel', handlePointerUp, { capture: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove, { capture: true });
      window.removeEventListener('pointerup', handlePointerUp, { capture: true });
      window.removeEventListener('pointercancel', handlePointerUp, { capture: true });
    };
  }, [isDragging]);

  if (!waveformData) {
    return null;
  }

  const handleSelect = () => {
    if (isDragging) return;
    onSelect?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  const audioDurationSeconds = waveformData.duration ?? 0;
  const totalPeaks = waveformData.peaks.length;

  // Calculate which portion of the audio maps to the visible timeline
  // effectiveOffset > 0: audio is delayed (silence at start, audio starts later)
  // effectiveOffset < 0: audio is trimmed (skip beginning of audio)

  // The audio source time that maps to video time 0
  const audioStartTime = -effectiveOffset; // If offset is +2s, audio at 0s maps to video 2s, so video 0s has no audio
  // If offset is -2s, audio at 2s maps to video 0s

  // The audio source time that maps to the end of the timeline
  const audioEndTime = audioStartTime + timelineDuration;

  // Convert to peak indices
  const peaksPerSecond = audioDurationSeconds > 0 ? totalPeaks / audioDurationSeconds : 0;

  // Calculate start and end peak indices for what's visible on the timeline
  const startPeakIndex = Math.max(0, Math.floor(audioStartTime * peaksPerSecond));
  const endPeakIndex = Math.min(totalPeaks, Math.ceil(audioEndTime * peaksPerSecond));

  // Extract the visible peaks
  const visiblePeaks = waveformData.peaks.slice(startPeakIndex, endPeakIndex);

  // Calculate padding at the start if offset > 0 (delay - silence at beginning)
  // This is the portion of the timeline before audio starts
  const silenceAtStart = Math.max(0, effectiveOffset);
  const silenceWidthPixels = silenceAtStart * pixelsPerSecond;

  // Calculate the width of the actual waveform
  const waveformWidthPixels = Math.max(0, trackWidth - silenceWidthPixels);

  // Check if there's more audio beyond what's visible
  const hasMoreAudioAtEnd = audioEndTime < audioDurationSeconds;

  return (
    <div
      className="w-full space-y-2"
      style={{ width: `${trackWidth}px` }}
    >
      <div
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={handleSelect}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        className={cn(
          'relative rounded-lg border border-border bg-secondary/20 overflow-hidden transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          onSelect && !onOffsetChange && 'cursor-pointer',
          onOffsetChange && !isDragging && 'cursor-grab',
          isDragging && 'cursor-grabbing',
          isSelected && 'border-primary ring-2 ring-primary shadow-lg'
        )}
        aria-pressed={isSelected}
      >
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 z-10 text-muted-foreground hover:text-destructive hover:bg-secondary/80"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            disabled={isLoading}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        <div className="flex h-[96px]">
          {/* Silence/gap at the start when offset > 0 */}
          {silenceWidthPixels > 0 && (
            <div
              className="shrink-0 bg-secondary/30"
              style={{ width: `${silenceWidthPixels}px` }}
            />
          )}
          {/* The actual waveform */}
          {waveformWidthPixels > 0 && visiblePeaks.length > 0 && (
            <div style={{ width: `${waveformWidthPixels}px` }} className="shrink-0">
              <AudioScrubber
                data={visiblePeaks}
                currentTime={Math.max(0, currentTime - silenceAtStart)}
                duration={Math.max(0, timelineDuration - silenceAtStart)}
                height={96}
                barWidth={3}
                barGap={1}
                barRadius={2}
                showHandle={false}
                fadeEdges={false}
                className="bg-secondary/50 [--foreground:oklch(0.951_0.121_125.737)]"
                aria-label={`${fileName} waveform`}
              />
            </div>
          )}
        </div>
        {hasMoreAudioAtEnd && (
          <div className="pointer-events-none absolute inset-y-0 right-0 flex w-24 items-center justify-end bg-gradient-to-l from-background/90 via-background/10 to-transparent pr-3">
            <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-background">
              More audio
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
