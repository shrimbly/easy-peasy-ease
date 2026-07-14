'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Scissors, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  clamp,
  formatTime,
  pixelsToTime,
  timeToPixels,
  extractVideoThumbnail,
} from '@/lib/timeline-utils';
import {
  deriveSections,
  insertSplit,
  moveSplit,
  removeSplit,
  canInsertSplit,
  MAX_SECTIONS,
} from '@/lib/chunking';

const FILMSTRIP_FRAMES = 8;
const NUDGE_SMALL = 0.1;
const NUDGE_LARGE = 1;

interface SplitTrackProps {
  url: string;
  duration: number;
  currentTime: number;
  splitTimes: number[];
  onSplitTimesChange: (splitTimes: number[]) => void;
  onSeek: (time: number) => void;
  disabled?: boolean;
}

/**
 * The interactive split track: a full-duration lane showing the source as a
 * filmstrip, the sections it's divided into, a scrubbing playhead, and
 * draggable split-point markers (add at playhead, drag to move, select +
 * Delete to remove, arrow keys to nudge).
 */
export function SplitTrack({
  url,
  duration,
  currentTime,
  splitTimes,
  onSplitTimesChange,
  onSeek,
  disabled = false,
}: SplitTrackProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [thumbnails, setThumbnails] = useState<Array<string | null>>([]);
  const [selectedSplit, setSelectedSplit] = useState<number | null>(null);
  const draggingIndexRef = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const safeDuration = duration > 0 ? duration : 0;
  const pixelsPerSecond = trackWidth > 0 && safeDuration > 0 ? trackWidth / safeDuration : 0;
  const sections = useMemo(
    () => deriveSections(safeDuration, splitTimes),
    [safeDuration, splitTimes]
  );
  const clampedCurrent = clamp(currentTime, 0, safeDuration);
  const atSectionCap = sections.length >= MAX_SECTIONS;
  const canAddAtPlayhead = !disabled && canInsertSplit(splitTimes, clampedCurrent, safeDuration);

  // Measure the track width.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => setTrackWidth(el.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver !== 'undefined') {
      const obs = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) setTrackWidth(entry.contentRect.width);
      });
      obs.observe(el);
      return () => obs.disconnect();
    }
  }, []);

  // Extract a lightweight filmstrip for context (best-effort, cancellable).
  useEffect(() => {
    if (!url || safeDuration <= 0) return;
    let cancelled = false;
    setThumbnails(new Array(FILMSTRIP_FRAMES).fill(null));
    (async () => {
      for (let i = 0; i < FILMSTRIP_FRAMES; i++) {
        const t = (safeDuration * (i + 0.5)) / FILMSTRIP_FRAMES;
        try {
          const thumb = await extractVideoThumbnail(url, t);
          if (cancelled) return;
          setThumbnails((prev) => {
            const next = [...prev];
            next[i] = thumb;
            return next;
          });
        } catch {
          if (cancelled) return;
          // Leave this cell as a placeholder; keep going.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, safeDuration]);

  // Keep the selected split in range as splits are added/removed.
  useEffect(() => {
    if (selectedSplit !== null && selectedSplit >= splitTimes.length) {
      setSelectedSplit(null);
    }
  }, [splitTimes.length, selectedSplit]);

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || pixelsPerSecond === 0) return 0;
      const rect = el.getBoundingClientRect();
      return clamp(pixelsToTime(clientX - rect.left, pixelsPerSecond), 0, safeDuration);
    },
    [pixelsPerSecond, safeDuration]
  );

  // ---- Scrubbing (click / drag on empty track) ----
  const scrubbingRef = useRef(false);
  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    setSelectedSplit(null);
    scrubbingRef.current = true;
    onSeek(timeFromClientX(e.clientX));
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    e.preventDefault();
    onSeek(timeFromClientX(e.clientX));
  };
  const handleTrackPointerUp = () => {
    scrubbingRef.current = false;
  };
  const handleTrackDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const t = timeFromClientX(e.clientX);
    // Inserting shifts positional indices; drop the (index-based) selection so
    // it can't end up pointing at a different split than the user selected.
    setSelectedSplit(null);
    onSplitTimesChange(insertSplit(splitTimes, t, safeDuration));
  };

  // ---- Marker dragging ----
  useEffect(() => {
    if (draggingIndex === null) return;
    const handleMove = (e: PointerEvent) => {
      const idx = draggingIndexRef.current;
      if (idx === null) return;
      e.preventDefault();
      const next = moveSplit(splitTimes, idx, timeFromClientX(e.clientX), safeDuration);
      onSplitTimesChange(next);
      // Scrub the preview to the split's actual (clamped) position so the user
      // sees the exact frame they're cutting on as they drag.
      const movedTo = next[idx];
      if (typeof movedTo === 'number') onSeek(movedTo);
    };
    const stop = () => {
      draggingIndexRef.current = null;
      setDraggingIndex(null);
    };
    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [draggingIndex, splitTimes, safeDuration, timeFromClientX, onSplitTimesChange, onSeek]);

  const startMarkerDrag = (index: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectedSplit(index);
    // Jump the preview to the grabbed split immediately, before any drag.
    onSeek(splitTimes[index]);
    draggingIndexRef.current = index;
    setDraggingIndex(index);
  };

  const handleMarkerKeyDown = (index: number) => (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onSplitTimesChange(removeSplit(splitTimes, index, safeDuration));
      setSelectedSplit(null);
      return;
    }
    const step = e.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const target = splitTimes[index] + (e.key === 'ArrowLeft' ? -step : step);
      const next = moveSplit(splitTimes, index, target, safeDuration);
      onSplitTimesChange(next);
      const movedTo = next[index];
      if (typeof movedTo === 'number') onSeek(movedTo);
    }
  };

  const addSplitAtPlayhead = () => {
    if (!canAddAtPlayhead) return;
    setSelectedSplit(null);
    onSplitTimesChange(insertSplit(splitTimes, clampedCurrent, safeDuration));
  };

  const playheadX = timeToPixels(clampedCurrent, pixelsPerSecond);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Scissors className="h-3.5 w-3.5" />
          <span>
            {sections.length} clip{sections.length === 1 ? '' : 's'} · drag to move, tap to remove
          </span>
        </div>
        <button
          type="button"
          onClick={addSplitAtPlayhead}
          disabled={!canAddAtPlayhead}
          className={cn(
            "relative inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium transition-colors after:absolute after:inset-x-0 after:inset-y-[-4px] after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            canAddAtPlayhead
              ? 'hover:bg-accent hover:text-accent-foreground'
              : 'cursor-not-allowed opacity-50'
          )}
          title={
            atSectionCap
              ? `Maximum of ${MAX_SECTIONS} clips reached`
              : 'Add a split at the playhead'
          }
        >
          <Plus className="h-3.5 w-3.5" />
          Split at playhead
        </button>
      </div>

      {/* Time ruler (decorative — must not intercept taps on nearby controls) */}
      <div className="pointer-events-none relative h-4 select-none">
        {pixelsPerSecond > 0 &&
          Array.from({ length: Math.floor(safeDuration) + 1 }, (_, s) => {
            // Thin out ruler labels on long clips to avoid crowding.
            const stride = safeDuration > 30 ? 5 : safeDuration > 12 ? 2 : 1;
            if (s % stride !== 0) return null;
            return (
              <div
                key={s}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center font-mono text-[10px] tabular-nums text-muted-foreground"
                style={{ left: `${timeToPixels(s, pixelsPerSecond)}px` }}
              >
                <div className="h-1.5 w-px bg-border" />
                <span>{s}s</span>
              </div>
            );
          })}
      </div>

      {/* The track */}
      <div
        ref={trackRef}
        className="relative h-24 w-full touch-none select-none overflow-hidden rounded-lg border border-border bg-secondary"
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={handleTrackPointerUp}
        onDoubleClick={handleTrackDoubleClick}
        role="group"
        aria-label="Split track"
      >
        {/* Filmstrip */}
        <div className="pointer-events-none absolute inset-0 flex">
          {thumbnails.map((thumb, i) => (
            <div key={i} className="h-full flex-1 border-r border-black/20 last:border-r-0">
              {thumb && (
                // Generated object URLs are already local, correctly sized
                // timeline frames; Next Image optimization adds no benefit.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb}
                  alt=""
                  className="h-full w-full object-cover opacity-40"
                  draggable={false}
                />
              )}
            </div>
          ))}
        </div>

        {/* Section overlays */}
        <div className="pointer-events-none absolute inset-0">
          {sections.map((section) => {
            const left = timeToPixels(section.start, pixelsPerSecond);
            const width = timeToPixels(section.duration, pixelsPerSecond);
            const isEven = section.index % 2 === 0;
            return (
              <div
                key={section.index}
                className={cn(
                  'absolute top-0 bottom-0 flex flex-col items-center justify-center gap-0.5 border-r border-primary/40 text-center',
                  isEven ? 'bg-primary/5' : 'bg-primary/15'
                )}
                style={{ left: `${left}px`, width: `${Math.max(width, 0)}px` }}
              >
                {width > 44 && (
                  <>
                    <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                      {section.index + 1}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-foreground/70">
                      {section.duration.toFixed(1)}s
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Playhead */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-foreground"
          style={{ left: `${playheadX}px` }}
        >
          <div className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-foreground" />
        </div>

        {/* Split markers */}
        {splitTimes.map((t, index) => {
          const x = timeToPixels(t, pixelsPerSecond);
          const isSelected = selectedSplit === index;
          const isDragging = draggingIndex === index;
          return (
            <div
              key={index}
              className="absolute top-0 bottom-0 z-30"
              style={{ left: `${x}px` }}
            >
              {/* Split line */}
              <div
                className={cn(
                  'pointer-events-none absolute top-0 bottom-0 -translate-x-1/2 transition-colors',
                  isSelected || isDragging ? 'w-0.5 bg-primary' : 'w-px bg-primary/70'
                )}
              />
              {/* Draggable handle. The button is a tall, finger-sized touch
                  target (32×64) centred on the line; the diamond inside is the
                  small visual. This keeps the grab area usable on phones while
                  the visible marker stays slim. */}
              <button
                type="button"
                aria-label={`Split point ${index + 1} at ${formatTime(t)}. Drag to move, Delete to remove.`}
                className={cn(
                  'absolute left-0 top-1/2 flex h-16 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center cursor-grab active:cursor-grabbing touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  disabled && 'cursor-not-allowed'
                )}
                onPointerDown={startMarkerDrag(index)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedSplit(index);
                  onSeek(splitTimes[index]);
                }}
                onKeyDown={handleMarkerKeyDown(index)}
              >
                <span
                  className={cn(
                    'pointer-events-none h-4 w-4 rotate-45 rounded-sm border-2 border-background bg-primary shadow-md transition-transform',
                    (isSelected || isDragging) && 'scale-125 ring-2 ring-primary/50'
                  )}
                />
              </button>
              {/* Delete affordance for the selected split */}
              {isSelected && !isDragging && (
                <button
                  type="button"
                  aria-label={`Remove split point ${index + 1}`}
                  className="absolute top-1 left-0 z-40 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSplitTimesChange(removeSplit(splitTimes, index, safeDuration));
                    setSelectedSplit(null);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
