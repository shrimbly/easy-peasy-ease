'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Pause, Play, Scissors, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/field-label';
import { ScrubbableNumberField } from '@/components/ui/scrubbable-number-field';
import { EasingCurvePicker } from '@/components/ui/easing-curve-picker';
import { SplitTrack } from '@/components/SplitTrack';
import { useVideoPlayback } from '@/hooks/useVideoPlayback';
import { formatTime } from '@/lib/timeline-utils';
import type { VideoEncodeCapability } from '@/lib/types';
import { DEFAULT_OUTPUT_DURATION, DEFAULT_EASING } from '@/lib/speed-curve-config';
import { getVideoPreviewAspectRatio } from '@/lib/video-preview';
import {
  deriveSections,
  computeEvenSplitTimes,
  sectionCountForLength,
  DEFAULT_SECTION_LENGTH,
  MAX_SECTIONS,
  MIN_SECTION_DURATION,
  type Section,
} from '@/lib/chunking';

export interface SplitConfig {
  sections: Section[];
  outputDuration: number;
  easingPreset: string;
}

interface VideoSplitEditorProps {
  file: File;
  url: string;
  duration: number;
  width?: number;
  height?: number;
  encodeCapability?: VideoEncodeCapability;
  easingOptions: string[];
  onCreate: (config: SplitConfig) => void;
  onBack: () => void;
  isBusy?: boolean;
}

const SECTION_LENGTH_MIN = 0.5;

export function VideoSplitEditor({
  file,
  url,
  duration,
  width,
  height,
  encodeCapability,
  easingOptions,
  onCreate,
  onBack,
  isBusy = false,
}: VideoSplitEditorProps) {
  const [splitTimes, setSplitTimes] = useState<number[]>(() =>
    computeEvenSplitTimes(duration, DEFAULT_SECTION_LENGTH)
  );
  const [sectionLength, setSectionLength] = useState(DEFAULT_SECTION_LENGTH);
  const [outputDuration, setOutputDuration] = useState(DEFAULT_OUTPUT_DURATION);
  const [easingPreset, setEasingPreset] = useState(
    easingOptions.includes(DEFAULT_EASING) ? DEFAULT_EASING : easingOptions[0] ?? DEFAULT_EASING
  );

  const { videoRef, state, togglePlayPause, seek } = useVideoPlayback();

  const sections = useMemo(() => deriveSections(duration, splitTimes), [duration, splitTimes]);
  const totalOutput = sections.length * outputDuration;
  const avgSection = sections.length > 0 ? duration / sections.length : 0;

  const sectionLengthMax = Math.max(SECTION_LENGTH_MIN, Math.floor(duration));
  const effectiveSectionLength = Math.min(sectionLength, sectionLengthMax);
  const previewCount = sectionCountForLength(duration, effectiveSectionLength);

  const applyEvenSplit = () => {
    setSplitTimes(computeEvenSplitTimes(duration, effectiveSectionLength));
  };

  const resetToSingle = () => setSplitTimes([]);

  const handleCreate = () => {
    onCreate({ sections, outputDuration, easingPreset });
  };

  const resolutionLabel = width && height ? `${width}×${height}` : null;
  const previewAspectRatio = getVideoPreviewAspectRatio(width, height);
  const encodeNote =
    encodeCapability?.status === 'unsupported' || encodeCapability?.status === 'error'
      ? encodeCapability.message
      : encodeCapability?.message?.startsWith('Will render')
        ? encodeCapability.message
        : null;

  return (
    // On lg the editor fills the viewport (minus the 8px page frame); the
    // video preview flexes to absorb the height and letterboxes itself.
    <div className="w-full flex flex-col lg:flex-row gap-4 lg:gap-2 max-w-[1800px] mx-auto lg:h-[calc(100vh-1rem)]">
      {/* Preview + track */}
      <div className="flex-1 flex flex-col gap-4 min-w-0 lg:min-h-0">
        <div
          className="relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-black shadow-xl lg:!aspect-auto lg:flex-1 lg:min-h-0"
          style={{ aspectRatio: previewAspectRatio }}
        >
          <video
            ref={videoRef}
            src={url}
            playsInline
            className="h-full w-full object-contain"
            preload="metadata"
          />
        </div>

        {/* Playback row */}
        <div className="flex items-center gap-3 px-1">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={togglePlayPause}
            aria-label={state.isPlaying ? 'Pause' : 'Play'}
          >
            {state.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {formatTime(state.currentTime)} / {formatTime(duration)}
          </span>
          {resolutionLabel && (
            <span className="ml-auto text-xs text-muted-foreground">{resolutionLabel}</span>
          )}
        </div>

        {/* The split track */}
        <div className="px-1">
          <SplitTrack
            url={url}
            duration={duration}
            currentTime={state.currentTime}
            splitTimes={splitTimes}
            onSplitTimesChange={setSplitTimes}
            onSeek={seek}
            disabled={isBusy}
          />
        </div>
      </div>

      {/* Controls */}
      <aside className="flex flex-col w-full lg:w-[360px] xl:w-[400px] shrink-0 rounded-lg border border-border bg-secondary p-4 gap-4 lg:sticky lg:top-2 lg:self-start">
        <div className="flex items-center gap-2">
          <Scissors className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold text-balance text-foreground">Split into clips</h2>
            <p className="text-xs text-pretty text-muted-foreground">Each clip is eased independently, then played in sequence.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0 space-y-1.5">
            <FieldLabel htmlFor="section-length">Clip length</FieldLabel>
            <ScrubbableNumberField
              id="section-length"
              label="Clip length"
              min={SECTION_LENGTH_MIN}
              max={sectionLengthMax}
              step={0.5}
              scrubStep={0.1}
              precision={1}
              unit="seconds"
              value={effectiveSectionLength}
              onChange={(value) => setSectionLength(value)}
              disabled={isBusy}
              className="w-full"
            />
            <p className="text-[11px] text-muted-foreground">
              ≈ {previewCount} clip{previewCount === 1 ? '' : 's'}
            </p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <FieldLabel htmlFor="output-duration">Clip duration</FieldLabel>
            <ScrubbableNumberField
              id="output-duration"
              label="Eased clip duration"
              min={0.3}
              max={4}
              step={0.05}
              scrubStep={0.01}
              precision={2}
              unit="seconds"
              value={outputDuration}
              onChange={setOutputDuration}
              disabled={isBusy}
              className="w-full"
            />
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={applyEvenSplit}
          disabled={isBusy}
          className="w-full gap-2"
        >
          <Wand2 className="h-4 w-4" />
          Split evenly every {effectiveSectionLength}s
        </Button>

        <div className="space-y-1.5 border-t border-border/60 pt-4">
          <FieldLabel htmlFor="section-easing">Curve</FieldLabel>
          <EasingCurvePicker
            id="section-easing"
            value={easingPreset}
            options={easingOptions}
            onChange={setEasingPreset}
            disabled={isBusy}
            align="start"
            fullWidth
          />
        </div>

        {/* Summary */}
        <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
          <div className="flex items-center justify-between font-mono tabular-nums">
            <span className="text-muted-foreground">
              {sections.length} clip{sections.length === 1 ? '' : 's'} · avg {avgSection.toFixed(1)}s
            </span>
            <span className="font-semibold">{formatTime(totalOutput)} total</span>
          </div>
          {sections.length >= MAX_SECTIONS && (
            <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              At the {MAX_SECTIONS}-clip maximum.
            </p>
          )}
          {sections.some((s) => s.duration < MIN_SECTION_DURATION + 0.05) && (
            <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              Some clips are very short.
            </p>
          )}
        </div>

        {encodeNote && (
          <p
            className={cn(
              'text-xs',
              encodeCapability?.status === 'unsupported' || encodeCapability?.status === 'error'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
            )}
          >
            {encodeNote}
          </p>
        )}

        <div className="mt-auto flex flex-col gap-2 border-t border-border/60 pt-4">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={resetToSingle}
              disabled={isBusy || splitTimes.length === 0}
              className="relative h-8 rounded-sm px-2 text-xs text-muted-foreground underline-offset-4 after:absolute after:inset-x-0 after:inset-y-[-4px] after:content-[''] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40 disabled:no-underline"
            >
              Clear splits
            </button>
            <span className="text-[11px] text-muted-foreground truncate max-w-[180px]" title={file.name}>
              {file.name}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onBack} disabled={isBusy} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button onClick={handleCreate} disabled={isBusy || sections.length === 0} className="flex-1 gap-2">
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              Create {sections.length} clip{sections.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
