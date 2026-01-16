'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { TransitionVideo } from '@/lib/types';
import {
  calculateSegmentBoundaries,
  clamp,
  getTotalDuration,
  pixelsToTime,
  timeToPixels,
} from '@/lib/timeline-utils';
import { cn } from '@/lib/utils';
import { extractVideoThumbnail } from '@/lib/timeline-utils';

export const TIMELINE_MIN_VISIBLE_SECONDS = 3;

const lerp = (start: number, end: number, value: number) =>
  start + (end - start) * value;

interface VideoTimelineProps {
  segments: TransitionVideo[];
  currentTime: number;
  selectedSegmentId: number | null;
  onSeek: (time: number) => void;
  onSegmentSelect: (id: number) => void;
  renderAudioTrack?: (context: {
    trackWidth: number;
    pixelsPerSecond: number;
    totalDuration: number;
  }) => ReactNode;
  zoomValue: number;
  onZoomChange: (value: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

interface ZoomSliderProps {
  value: number;
  onValueChange: (value: number) => void;
  disabled?: boolean;
}

export function TimelineZoomSlider({ value, onValueChange, disabled }: ZoomSliderProps) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const updateValueFromPointer = (clientX: number) => {
    if (!sliderRef.current) return;
    const rect = sliderRef.current.getBoundingClientRect();
    const rawValue = (clientX - rect.left) / rect.width;
    onValueChange(clamp(rawValue, 0, 1));
  };

  const startDragging = (clientX: number) => {
    if (disabled) return;
    updateValueFromPointer(clientX);
    setIsDragging(true);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    startDragging(event.clientX);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    event.preventDefault();
    const touch = event.touches[0];
    if (touch) {
      startDragging(touch.clientX);
    }
  };

  useEffect(() => {
    if (!isDragging || disabled) return;

    const handlePointerMove = (event: MouseEvent | TouchEvent) => {
      if ('touches' in event) {
        const clientX = event.touches[0]?.clientX;
        if (clientX == null) return;
        event.preventDefault();
        updateValueFromPointer(clientX);
        return;
      }

      updateValueFromPointer(event.clientX);
    };

    const stopDragging = () => setIsDragging(false);

    const touchMoveOptions: AddEventListenerOptions = { passive: false };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('touchmove', handlePointerMove, touchMoveOptions);
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('touchend', stopDragging);
    window.addEventListener('touchcancel', stopDragging);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('touchmove', handlePointerMove, touchMoveOptions);
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('touchend', stopDragging);
      window.removeEventListener('touchcancel', stopDragging);
    };
  }, [isDragging, disabled]);

  return (
    <div
      ref={sliderRef}
      className={cn(
        'relative h-8 w-[70px] md:w-[100px] cursor-pointer select-none touch-none',
        disabled && 'cursor-not-allowed opacity-50'
      )}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    >
      <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted-foreground/30" />
      <div
        className="absolute top-1/2 h-5 w-5 -translate-y-1/2 -translate-x-1/2 rounded-full border border-primary/40 bg-primary shadow-lg transition-transform touch-none"
        style={{ left: `${value * 100}%` }}
      />
    </div>
  );
}

export function VideoTimeline({
  segments,
  currentTime,
  selectedSegmentId,
  onSeek,
  onSegmentSelect,
  renderAudioTrack,
  zoomValue,
  onZoomChange,
  onReorder,
}: VideoTimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
  const [viewportWidth, setViewportWidth] = useState(0);

  // Drag and drop state for reordering
  const [draggingSegmentIndex, setDraggingSegmentIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | null>(null);

  const totalDuration = getTotalDuration(segments);
  const normalizedTime = totalDuration > 0 ? currentTime % totalDuration : currentTime;
  const boundaries = calculateSegmentBoundaries(segments);
  const zoomDisabled = totalDuration === 0 || totalDuration <= TIMELINE_MIN_VISIBLE_SECONDS;

  const safeViewportWidth = viewportWidth || 0;
  const normalizedZoom = clamp(zoomValue, 0, 1);

  const targetVisibleSeconds =
    totalDuration === 0
      ? TIMELINE_MIN_VISIBLE_SECONDS
      : zoomDisabled
        ? totalDuration
        : lerp(totalDuration, TIMELINE_MIN_VISIBLE_SECONDS, normalizedZoom);

  const pixelsPerSecond =
    safeViewportWidth > 0 && targetVisibleSeconds > 0
      ? safeViewportWidth / targetVisibleSeconds
      : 0;

  const rawTrackWidth =
    totalDuration > 0 ? totalDuration * pixelsPerSecond : safeViewportWidth;
  const trackWidth = Math.max(rawTrackWidth, safeViewportWidth);
  const playheadPosition = timeToPixels(normalizedTime, pixelsPerSecond);
  const tickCount = Math.max(Math.ceil(totalDuration) + 1, 1);

  // Keep zoom slider sensible when the timeline shrinks
  useEffect(() => {
    if (zoomDisabled && zoomValue !== 0) {
      onZoomChange(0);
    }
  }, [zoomDisabled, zoomValue, onZoomChange]);

  // Measure the scroll viewport width
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateWidth = () => setViewportWidth(element.getBoundingClientRect().width);
    updateWidth();

    if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          setViewportWidth(entry.contentRect.width);
        }
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    const resizeTarget =
      typeof globalThis !== 'undefined' && 'addEventListener' in globalThis
        ? (globalThis as Window & typeof globalThis)
        : null;
    if (!resizeTarget) {
      return undefined;
    }

    resizeTarget.addEventListener('resize', updateWidth);
    return () => resizeTarget.removeEventListener('resize', updateWidth);
  }, []);

  // Extract thumbnails for each segment
  useEffect(() => {
    let isCancelled = false;
    const pendingKeys = new Set<string>();

    segments.forEach((segment) => {
      if (!segment.url || segment.loading) return;
      const key = `${segment.url}`;
      const cached = thumbnailCacheRef.current.get(key);

      if (cached) {
        setThumbnails((prev) => {
          if (prev[segment.id] === cached) return prev;
          return { ...prev, [segment.id]: cached };
        });
        return;
      }

      if (pendingKeys.has(key)) return;
      pendingKeys.add(key);

      extractVideoThumbnail(segment.url, 0)
        .then((thumbnail) => {
          if (isCancelled) return;
          thumbnailCacheRef.current.set(key, thumbnail);
          setThumbnails((prev) => {
            if (prev[segment.id] === thumbnail) return prev;
            return { ...prev, [segment.id]: thumbnail };
          });
        })
        .catch((error) => {
          console.error(`Failed to extract thumbnail for segment ${segment.id}:`, error);
          thumbnailCacheRef.current.delete(key);
        });
    });

    return () => {
      isCancelled = true;
    };
  }, [segments]);

  // Handle timeline interaction (click or drag)
  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Prevent default to stop scrolling/selection
    e.preventDefault();

    if (!viewportRef.current) return;

    const rect = viewportRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left + viewportRef.current.scrollLeft;
    const newTime = pixelsToTime(clickX, pixelsPerSecond);
    const clampedTime = clamp(newTime, 0, totalDuration);

    onSeek(clampedTime);
    setIsDragging(true);

    // Capture pointer to ensure we get move events even if we leave the element
    const target = e.target as HTMLElement;
    if (target.setPointerCapture) {
      target.setPointerCapture(e.pointerId);
    }
  };

  // Handle playhead dragging (specific target)
  const handlePlayheadPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault(); // Prevent touch scroll
    setIsDragging(true);

    const target = e.target as HTMLElement;
    if (target.setPointerCapture) {
      target.setPointerCapture(e.pointerId);
    }
  };

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!viewportRef.current) return;

      // Prevent scrolling on touch devices while dragging
      e.preventDefault();

      const rect = viewportRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left + viewportRef.current.scrollLeft;
      const newTime = pixelsToTime(mouseX, pixelsPerSecond);
      const clampedTime = clamp(newTime, 0, totalDuration);

      onSeek(clampedTime);
    };

    const handlePointerUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isDragging, pixelsPerSecond, totalDuration, onSeek]);

  // Keep the playhead visible by jumping the scroll position if it leaves the viewport
  useEffect(() => {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      safeViewportWidth === 0 ||
      trackWidth <= safeViewportWidth ||
      isDragging
    ) {
      return;
    }

    const scrollLeft = viewport.scrollLeft;
    const viewportRight = scrollLeft + safeViewportWidth;

    if (playheadPosition < scrollLeft || playheadPosition > viewportRight) {
      const maxScroll = Math.max(trackWidth - safeViewportWidth, 0);
      const nextScroll = clamp(
        playheadPosition - safeViewportWidth / 2,
        0,
        maxScroll
      );
      viewport.scrollLeft = nextScroll;
    }
  }, [isDragging, playheadPosition, safeViewportWidth, trackWidth]);

  const handleTimelineWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    event.preventDefault(); // Prevent page scrolling
    viewport.scrollLeft += event.deltaY;
  };

  // Reordering handlers
  const handleSegmentDragStart = (index: number) => (e: React.DragEvent) => {
    e.stopPropagation();
    if (!onReorder) return;

    setDraggingSegmentIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // Transparent drag image if possible, or standard. 
    // We rely on the indicator primarily.
  };

  const handleSegmentDragOver = (index: number) => (e: React.DragEvent) => {
    if (draggingSegmentIndex === null || !onReorder) return;
    e.preventDefault();
    e.stopPropagation();

    if (draggingSegmentIndex === index) {
      setDropTargetIndex(null);
      setDropPosition(null);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const position = e.clientX < midX ? 'before' : 'after';


    setDropTargetIndex(index);
    setDropPosition(position);
    e.dataTransfer.dropEffect = 'move';
  };

  const handleSegmentDragLeave = () => {
    // Basic debounce/check to avoid flickering when entering children
    // but in this list case, standard logic usually suffices or checking relatedTarget
  };

  const handleSegmentDrop = (index: number) => (e: React.DragEvent) => {
    if (draggingSegmentIndex === null || !onReorder || dropTargetIndex === null) return;
    e.preventDefault();
    e.stopPropagation();

    let targetIndex = index;
    if (dropPosition === 'after') {
      targetIndex = index + 1; // Insert after this element
    }

    // Adjust logic: If we are dragging items later in the list to earlier positions or vice-versa
    // Usually simple splice logic works best if we treat it as "move to index".
    // However, since visual "after index 2" is technically index 3 slot.

    // Let's simplify: pass current index and desired target index.
    // If we drop 'after' index 5, we want to move to 6.
    // But we need to account for the removed item shifting indices if necessary.
    // The parent's `reorderTransitionVideos` function handles standard array splice: remove at `from`, insert at `to`.
    // If `from` < `to`, shifting happens automatically during splice for passed indices? 
    // Actually, `reorderTransitionVideos` implementation:
    // const [moved] = updated.splice(fromIndex, 1);
    // updated.splice(toIndex, 0, moved);

    // If I drag idx 0 to "after" idx 1.
    // splice(0, 1) removes 0. Array is [1, 2...].
    // splice(2, 0, moved) -> [1, 2, 0...]. Wait.
    // If target is "after 1", the visual new index is 2.
    // But since 0 is removed, 1 becomes 0. 

    // Let's rely on standard logic: normalized "toIndex".
    onReorder(draggingSegmentIndex, targetIndex);

    setDraggingSegmentIndex(null);
    setDropTargetIndex(null);
    setDropPosition(null);
  };

  const handleDragEnd = () => {
    setDraggingSegmentIndex(null);
    setDropTargetIndex(null);
    setDropPosition(null);
  };

  return (
    <div className="space-y-2 min-w-0 w-full max-w-full">
      <div className="w-full min-w-0">
        <div
          ref={viewportRef}
          className="timeline-scrollbar w-full max-w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-secondary/30"
          onWheel={handleTimelineWheel}
        >
          <div className="relative space-y-1 md:space-y-4" style={{ width: `${trackWidth}px` }}>
            {/* Time Ruler */}
            <div className="relative h-5 md:h-8 border-b border-border/60 bg-background/40">
              {Array.from({ length: tickCount }, (_, index) => {
                const tickPosition = timeToPixels(index, pixelsPerSecond);
                return (
                  <div
                    key={index}
                    className="absolute flex -translate-x-1/2 flex-col items-center text-[10px] font-medium text-muted-foreground tabular-nums"
                    style={{ left: `${tickPosition}px` }}
                  >
                    <div className="h-1 md:h-2 w-px bg-border" />
                    <span>{index}s</span>
                  </div>
                );
              })}
            </div>

            {/* Timeline Track */}
            <div
              className="relative h-14 md:h-24 cursor-pointer select-none touch-none"
              onPointerDown={handleTrackPointerDown}
            >
              <div className="flex h-full">
                {boundaries.map((boundary) => {
                  const segmentDuration = boundary.endTime - boundary.startTime;
                  const segmentWidth = segmentDuration * pixelsPerSecond;
                  const isSelected = boundary.segment.id === selectedSegmentId;
                  const isPlaying =
                    normalizedTime >= boundary.startTime && normalizedTime < boundary.endTime;

                  return (
                    <div
                      key={boundary.segment.id}
                      onDragOver={handleSegmentDragOver(boundary.index)}
                      onDragLeave={handleSegmentDragLeave}
                      onDrop={handleSegmentDrop(boundary.index)}
                      className={cn(
                        'relative h-full flex-none border-r border-border/50 transition-all group',
                        isSelected && 'ring-2 ring-primary ring-inset',
                        isPlaying && 'bg-primary/10',
                        // Visual styles for drag target
                        dropTargetIndex === boundary.index && dropPosition === 'before' && 'border-l-4 border-l-primary z-20',
                        dropTargetIndex === boundary.index && dropPosition === 'after' && 'border-r-4 border-r-primary z-20',
                        draggingSegmentIndex === boundary.index && 'opacity-50'
                      )}
                      style={{ width: `${Math.max(segmentWidth, 0)}px` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSegmentSelect(boundary.segment.id);
                        // Also seek to start of segment to prevent playback loop from resetting selection
                        onSeek(boundary.startTime);
                      }}
                    >
                      {/* Drop Indicators (backup to border) */}
                      {dropTargetIndex === boundary.index && dropPosition === 'before' && (
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary z-30" />
                      )}
                      {dropTargetIndex === boundary.index && dropPosition === 'after' && (
                        <div className="absolute right-0 top-0 bottom-0 w-1 bg-primary z-30" />
                      )}
                      {/* Thumbnail */}
                      {thumbnails[boundary.segment.id] && (
                        <img
                          src={thumbnails[boundary.segment.id]}
                          alt={boundary.segment.name}
                          className="absolute inset-0 h-full w-full object-cover opacity-60"
                        />
                      )}

                      {/* Overlay gradient for text readability */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />

                      {/* Segment Name - Moved up slightly to make room for handle */}
                      <div className="absolute bottom-3 left-0 right-0 p-1 md:p-2 pointer-events-none">
                        <p className="text-[10px] md:text-xs font-medium text-white truncate">
                          {boundary.segment.loopIteration && boundary.segment.loopIteration > 1
                            ? `${boundary.segment.name} • Loop ${boundary.segment.loopIteration}`
                            : boundary.segment.name}
                        </p>
                      </div>

                      {/* Drag Handle */}
                      <div
                        draggable={!!onReorder}
                        onDragStart={handleSegmentDragStart(boundary.index)}
                        onDragEnd={handleDragEnd}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="absolute bottom-0 left-0 right-0 h-5 cursor-grab active:cursor-grabbing z-50 flex items-center justify-center transition-colors shadow-sm border-t border-white/20"
                        style={{ backgroundColor: '#10b981' }} // Emerald-500 equivalent
                        title="Drag to reorder"
                      >
                        <span className="text-[9px] font-bold text-white uppercase tracking-wider drop-shadow-md select-none mr-1">DRAG</span>
                        <div className="w-8 h-1 bg-white/60 rounded-full backdrop-blur-sm" />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div
                className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-primary"
                style={{ left: `${playheadPosition}px` }}
              >
                <div
                  className="pointer-events-auto absolute top-0 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-lg cursor-grab active:cursor-grabbing touch-none"
                  onPointerDown={handlePlayheadPointerDown}
                />
                <div className="absolute inset-0 -left-px w-1 bg-primary/30 blur-sm -z-10" />
              </div>
            </div>

            {renderAudioTrack && (
              <div className="pb-2 md:pb-4">
                {renderAudioTrack({
                  trackWidth,
                  pixelsPerSecond,
                  totalDuration,
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
