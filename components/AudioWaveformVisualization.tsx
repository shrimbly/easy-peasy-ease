'use client';

import { type KeyboardEvent, useState, useRef, useEffect, useCallback } from 'react';
import { WaveformData } from '@/hooks/useAudioVisualization';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AudioScrubber } from '@/components/ui/waveform';
import { BeatSyncControl } from '@/components/BeatSyncControl';
import { MIN_ANALYSIS_SECONDS } from '@/lib/beat-detection';
import {
  emphasisAnchorVideoTime,
  firstBeatVideoTime,
  type BeatSubdivision,
} from '@/lib/beat-sync';

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
  /** Active beat-snap subdivision; 0 = off. */
  beatSubdivision?: BeatSubdivision | 0;
  onBeatSubdivisionChange?: (value: BeatSubdivision | 0) => void;
  /** Re-render CTA inside the beat pill (shown while snapping is active). */
  onBeatApply?: () => void;
  isBeatUpdating?: boolean;
}

const AUDIO_TRACK_HEIGHT = 48;

const positiveModulo = (value: number, modulus: number): number => {
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
};

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
  beatSubdivision = 0,
  onBeatSubdivisionChange,
  onBeatApply,
  isBeatUpdating = false,
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
    // Keys bubbling from the remove button must activate it, not the track.
    if (event.target !== event.currentTarget) return;
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

  // Beat ticks: faint lines on every beat (anchored to the audio, so they
  // follow the waveform live while dragging), plus brighter lines marking the
  // active every-Nth-beat grid section boundaries snap to. Rendered as
  // repeating gradients — two layers regardless of beat count. The layer is
  // clipped to the source audio's span: past its end the track loop-fills
  // from an arbitrary point, so the extrapolated grid would be a lie there.
  const beats = waveformData.beats;
  const beatTicks = (() => {
    if (!beats || pixelsPerSecond <= 0) {
      return null;
    }
    const periodPx = beats.period * pixelsPerSecond;
    if (periodPx < 4) {
      return null; // zoomed out too far for ticks to read
    }
    const layerStartTime = Math.max(0, effectiveOffset); // where audio begins
    const layerEndTime = Math.min(
      timelineDuration,
      effectiveOffset + audioDurationSeconds
    );
    const leftPx = layerStartTime * pixelsPerSecond;
    const widthPx = Math.min(trackWidth, layerEndTime * pixelsPerSecond) - leftPx;
    if (widthPx <= 0) {
      return null;
    }
    const firstBeat = firstBeatVideoTime(beats, effectiveOffset);
    const faintPhasePx =
      positiveModulo(firstBeat - layerStartTime, beats.period) * pixelsPerSecond;
    let emphasis: { spacingPx: number; phasePx: number } | null = null;
    if (beatSubdivision !== 0) {
      const groupPeriod = beats.period * beatSubdivision;
      const anchor = emphasisAnchorVideoTime(beats, effectiveOffset);
      emphasis = {
        spacingPx: groupPeriod * pixelsPerSecond,
        phasePx:
          positiveModulo(anchor - layerStartTime, groupPeriod) * pixelsPerSecond,
      };
    }
    return { leftPx, widthPx, periodPx, faintPhasePx, emphasis };
  })();

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
          'relative overflow-hidden rounded-md border border-border bg-secondary/20 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
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
            aria-label={`Remove ${fileName} audio track`}
            className="absolute right-2 top-2 z-10 text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            // pointerdown must not reach the track: its drag handler captures
            // the pointer, which retargets the click away from this button.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            disabled={isLoading}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        <div className="flex h-12">
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
                height={AUDIO_TRACK_HEIGHT}
                barWidth={3}
                barGap={1}
                barRadius={2}
                showHandle={false}
                fadeEdges={false}
                className="bg-secondary/50 [--foreground:var(--primary)]"
                aria-label={`${fileName} waveform`}
              />
            </div>
          )}
        </div>

        {/* Beat grid */}
        {beatTicks && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0"
            style={{ left: `${beatTicks.leftPx}px`, width: `${beatTicks.widthPx}px` }}
          >
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `repeating-linear-gradient(90deg, color-mix(in srgb, var(--primary) 30%, transparent) 0 1px, transparent 1px ${beatTicks.periodPx}px)`,
                backgroundPositionX: `${beatTicks.faintPhasePx}px`,
              }}
            />
            {beatTicks.emphasis && (
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `repeating-linear-gradient(90deg, color-mix(in srgb, var(--primary) 80%, transparent) 0 2px, transparent 2px ${beatTicks.emphasis.spacingPx}px)`,
                  backgroundPositionX: `${beatTicks.emphasis.phasePx}px`,
                }}
              />
            )}
          </div>
        )}

        {/* Beat snap pill; capped so it wraps instead of reaching under the
            remove button on narrow tracks. */}
        {beats && onBeatSubdivisionChange && (
          <BeatSyncControl
            bpm={beats.bpm}
            period={beats.period}
            value={beatSubdivision}
            onValueChange={onBeatSubdivisionChange}
            onApply={onBeatApply}
            isUpdating={isBeatUpdating}
            className="absolute left-2 top-2 z-10 max-w-[calc(100%-3.5rem)] flex-wrap"
          />
        )}
        {/* Analysis ran on a full-length track but found no steady grid. */}
        {!beats &&
          onBeatSubdivisionChange &&
          audioDurationSeconds >= MIN_ANALYSIS_SECONDS && (
            <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-md border border-border/70 bg-background/85 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur-sm">
              No steady beat
            </span>
          )}
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
