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
        'relative h-8 w-[100px] cursor-pointer select-none touch-none',
        disabled && 'cursor-not-allowed opacity-50'
      )}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    >
      <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border/60" />
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
}: VideoTimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
  const [viewportWidth, setViewportWidth] = useState(0);

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

  // Handle click on timeline to seek
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!viewportRef.current) return;

    const rect = viewportRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left + viewportRef.current.scrollLeft;
    const newTime = pixelsToTime(clickX, pixelsPerSecond);
    const clampedTime = clamp(newTime, 0, totalDuration);

    onSeek(clampedTime);
  };

  // Handle playhead dragging
  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!viewportRef.current) return;

      const rect = viewportRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left + viewportRef.current.scrollLeft;
      const newTime = pixelsToTime(mouseX, pixelsPerSecond);
      const clampedTime = clamp(newTime, 0, totalDuration);

      onSeek(clampedTime);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
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
    if (!viewport || trackWidth <= safeViewportWidth) return;

    const isVerticalDominant = Math.abs(event.deltaY) > Math.abs(event.deltaX);
    if (!isVerticalDominant || event.deltaY === 0) return;

    event.preventDefault();
    viewport.scrollLeft += event.deltaY;
  };

  return (
    <div className="space-y-2 min-w-0 w-full max-w-full">
      <div className="w-full min-w-0">
        <div
          ref={viewportRef}
          className="timeline-scrollbar w-full max-w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-secondary/30"
          onWheel={handleTimelineWheel}
        >
          <div className="relative space-y-4" style={{ width: `${trackWidth}px` }}>
            {/* Time Ruler */}
            <div className="relative h-8 border-b border-border/60 bg-background/40">
              {Array.from({ length: tickCount }, (_, index) => {
                const tickPosition = timeToPixels(index, pixelsPerSecond);
                return (
                  <div
                    key={index}
                    className="absolute flex -translate-x-1/2 flex-col items-center text-[10px] font-medium text-muted-foreground tabular-nums"
                    style={{ left: `${tickPosition}px` }}
                  >
                    <div className="h-2 w-px bg-border" />
                    <span>{index}s</span>
                  </div>
                );
              })}
            </div>

            {/* Timeline Track */}
            <div
              className="relative h-24 cursor-pointer select-none"
              onClick={handleTimelineClick}
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
                      className={cn(
                        'relative h-full flex-none border-r border-border/50 transition-all',
                        isSelected && 'ring-2 ring-primary ring-inset',
                        isPlaying && 'bg-primary/10'
                      )}
                      style={{ width: `${Math.max(segmentWidth, 0)}px` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSegmentSelect(boundary.segment.id);
                      }}
                    >
                      {/* Thumbnail */}
                      {thumbnails[boundary.segment.id] && (
                        <img
                          src={thumbnails[boundary.segment.id]}
                          alt={boundary.segment.name}
                          className="absolute inset-0 h-full w-full object-cover opacity-60"
                        />
                      )}

                      {/* Overlay gradient for text readability */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />

                      {/* Segment Name */}
                      <div className="absolute bottom-0 left-0 right-0 p-2">
                        <p className="text-xs font-medium text-white truncate">
                          {boundary.segment.loopIteration && boundary.segment.loopIteration > 1
                            ? `${boundary.segment.name} • Loop ${boundary.segment.loopIteration}`
                            : boundary.segment.name}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Playhead */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-primary"
                style={{ left: `${playheadPosition}px` }}
              >
                <div
                  className="pointer-events-auto absolute top-0 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-lg cursor-grab active:cursor-grabbing"
                  onMouseDown={handlePlayheadMouseDown}
                />
                <div className="absolute inset-0 -left-px w-1 bg-primary/30 blur-sm -z-10" />
              </div>
            </div>

            {renderAudioTrack && (
              <div className="pb-4">
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
