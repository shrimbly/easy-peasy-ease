'use client';

import { ChangeEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FinalVideo, TransitionVideo, AudioProcessingOptions, RenderQuality } from '@/lib/types';
import { Label } from '@/components/ui/label';
import { CubicBezierEditor } from '@/components/CubicBezierEditor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Play } from 'lucide-react';
import { getPresetBezier } from '@/lib/easing-presets';
import { useVideoPlayback } from '@/hooks/useVideoPlayback';
import { VideoPlaybackControls } from '@/components/VideoPlaybackControls';
import {
  VideoTimeline,
  TimelineZoomSlider,
  TIMELINE_MIN_VISIBLE_SECONDS,
} from '@/components/VideoTimeline';
import { getCurrentSegment, getTotalDuration } from '@/lib/timeline-utils';
import { AudioUploadBox } from '@/components/AudioUploadBox';
import { AudioWaveformVisualization } from '@/components/AudioWaveformVisualization';
import { useAudioVisualization } from '@/hooks/useAudioVisualization';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const LOOP_OPTIONS = [1, 2, 3] as const;
const BEZIER_THROTTLE_MS = 75;

interface FinalVideoEditorProps {
  finalVideo: FinalVideo;
  segments: TransitionVideo[];
  selectedSegmentId: number | null;
  easingOptions: string[];
  onSelectSegment: (id: number) => void;
  onDurationChange: (id: number, duration: number, applyAll?: boolean) => void;
  onPresetChange: (id: number, preset: string, applyAll?: boolean) => void;
  onBezierChange: (id: number, bezier: [number, number, number, number], applyAll?: boolean) => void;
  defaultBezier: [number, number, number, number];
  onCloneSegmentSettings: (id: number) => void;
  onUpdateVideo: (options?: { audioBlob?: Blob; audioSettings?: AudioProcessingOptions; quality?: RenderQuality }) => void;
  isUpdating: boolean;
  onExit: () => void;
  onDownload: () => void;
  loopCount: number;
  onLoopCountChange: (next: number) => void;
  renderQuality: RenderQuality;
  onRenderQualityChange: (quality: RenderQuality) => void;
  currentRenderQuality: RenderQuality | null;
}

export const FinalVideoEditor = memo(FinalVideoEditorComponent);

function FinalVideoEditorComponent({
  finalVideo,
  segments,
  selectedSegmentId,
  easingOptions,
  onSelectSegment,
  onDurationChange,
  onPresetChange,
  onBezierChange,
  defaultBezier,
  onCloneSegmentSettings,
  onUpdateVideo,
  isUpdating,
  onExit,
  onDownload,
  loopCount,
  onLoopCountChange,
  renderQuality,
  onRenderQualityChange,
  currentRenderQuality,
}: FinalVideoEditorProps) {
  const selectedSegment = useMemo(
    () => segments.find((segment) => segment.id === selectedSegmentId) ?? null,
    [segments, selectedSegmentId]
  );
  const [applyAll, setApplyAll] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [inspectorView, setInspectorView] = useState<'segments' | 'audio' | 'export'>('segments');
  const [audioSettings, setAudioSettings] = useState<AudioProcessingOptions>({
    fadeIn: 0.5,
    fadeOut: 0.5,
  });
  const [updatePromptReason, setUpdatePromptReason] = useState<'loop' | 'audio' | null>(null);
  const [pendingFullQualityDownload, setPendingFullQualityDownload] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(0);
  const [localCurve, setLocalCurve] = useState<[number, number, number, number] | null>(null);
  const bezierPendingRef = useRef<{
    segmentId: number;
    bezier: [number, number, number, number];
    applyAll: boolean;
  } | null>(null);
  const bezierTimeoutRef = useRef<number | null>(null);

  const totalTimelineDuration = useMemo(() => getTotalDuration(segments), [segments]);
  const timelineZoomDisabled =
    totalTimelineDuration === 0 || totalTimelineDuration <= TIMELINE_MIN_VISIBLE_SECONDS;

  // Audio visualization
  const { waveformData, isLoading: isAudioLoading } = useAudioVisualization(audioFile);

  const flushPendingBezier = useCallback(
    (
      overridePayload?: {
        segmentId: number;
        bezier: [number, number, number, number];
        applyAll: boolean;
      }
    ) => {
      const payload = overridePayload ?? bezierPendingRef.current;
      if (!payload) return;
      bezierPendingRef.current = null;
      if (bezierTimeoutRef.current !== null) {
        clearTimeout(bezierTimeoutRef.current);
        bezierTimeoutRef.current = null;
      }
      onBezierChange(payload.segmentId, payload.bezier, payload.applyAll);
    },
    [onBezierChange]
  );

  useEffect(() => {
    return () => {
      flushPendingBezier();
    };
  }, [flushPendingBezier]);

  const scheduleBezierChange = useCallback(
    (segmentId: number, bezier: [number, number, number, number], applyToAll: boolean) => {
      bezierPendingRef.current = { segmentId, bezier, applyAll: applyToAll };
      if (bezierTimeoutRef.current !== null) {
        return;
      }
      bezierTimeoutRef.current = window.setTimeout(() => {
        bezierTimeoutRef.current = null;
        flushPendingBezier();
      }, BEZIER_THROTTLE_MS);
    },
    [flushPendingBezier]
  );

  const baseCurveValue = useMemo(() => {
    if (!selectedSegment) return defaultBezier;
    if (selectedSegment.useCustomEasing && selectedSegment.customBezier) {
      return selectedSegment.customBezier;
    }
    if (selectedSegment.easingPreset) {
      return getPresetBezier(selectedSegment.easingPreset);
    }
    return defaultBezier;
  }, [defaultBezier, selectedSegment]);

  useEffect(() => {
    setLocalCurve(null);
  }, [selectedSegmentId]);

  useEffect(() => {
    if (!localCurve) return;
    const isMatching =
      Math.abs(localCurve[0] - baseCurveValue[0]) < 1e-4 &&
      Math.abs(localCurve[1] - baseCurveValue[1]) < 1e-4 &&
      Math.abs(localCurve[2] - baseCurveValue[2]) < 1e-4 &&
      Math.abs(localCurve[3] - baseCurveValue[3]) < 1e-4;
    if (isMatching) {
      setLocalCurve(null);
    }
  }, [baseCurveValue, localCurve]);

  const curveValue = localCurve ?? baseCurveValue;

  const handleBezierChange = useCallback(
    (nextValue: [number, number, number, number]) => {
      if (!selectedSegment) return;
      setLocalCurve(nextValue);
      scheduleBezierChange(selectedSegment.id, nextValue, applyAll);
    },
    [applyAll, scheduleBezierChange, selectedSegment]
  );

  const handleBezierCommit = useCallback(
    (finalValue: [number, number, number, number]) => {
      if (!selectedSegment) return;
      setLocalCurve(finalValue);
      flushPendingBezier({
        segmentId: selectedSegment.id,
        bezier: finalValue,
        applyAll,
      });
    },
    [applyAll, flushPendingBezier, selectedSegment]
  );

  const handleSegmentSelect = useCallback(
    (segmentId: number) => {
      setInspectorView('segments');
      onSelectSegment(segmentId);
    },
    [onSelectSegment]
  );

  // Video playback control
  const { videoRef, state, togglePlayPause, seek } = useVideoPlayback((currentTime) => {
    // Auto-select segment based on playback position
    const currentSegment = getCurrentSegment(currentTime, segments);
    if (currentSegment && currentSegment.id !== selectedSegmentId) {
      handleSegmentSelect(currentSegment.id);
    }
  });

  const handleAudioSelect = useCallback((file: File) => {
    setAudioFile(file);
    setUpdatePromptReason('audio');
  }, []);

  const handleRemoveAudio = useCallback(() => {
    setAudioFile(null);
    if (inspectorView === 'audio') {
      setInspectorView('segments');
    }
  }, [inspectorView]);

  const handleAudioTrackSelect = useCallback(() => {
    if (!waveformData) return;
    setInspectorView('audio');
  }, [waveformData]);

  const updateAudioSetting = (property: 'fadeIn' | 'fadeOut', value: number) => {
    const sanitizedValue = Number.isNaN(value) ? 0 : value;
    setAudioSettings((prev) => ({
      ...prev,
      [property]: Math.min(Math.max(sanitizedValue, 0), 10),
    }));
  };

  const handleLoopDropdownChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextValue = Number(event.target.value);
      if (nextValue === loopCount) return;
      onLoopCountChange(nextValue);
      setUpdatePromptReason('loop');
    },
    [loopCount, onLoopCountChange]
  );

  const handleVideoUpdate = (qualityOverride?: RenderQuality) => {
    onUpdateVideo({
      audioBlob: audioFile ?? undefined,
      audioSettings,
      quality: qualityOverride ?? renderQuality,
    });
    setUpdatePromptReason(null);
  };

  const handleDownload = useCallback(() => {
    // If current render is preview, we need to re-render at full quality first
    if (currentRenderQuality === 'preview') {
      setPendingFullQualityDownload(true);
      onUpdateVideo({
        audioBlob: audioFile ?? undefined,
        audioSettings,
        quality: 'full',
      });
    } else {
      onDownload();
    }
  }, [currentRenderQuality, audioFile, audioSettings, onUpdateVideo, onDownload]);

  // Trigger download when full quality render completes
  useEffect(() => {
    if (pendingFullQualityDownload && !isUpdating && currentRenderQuality === 'full') {
      setPendingFullQualityDownload(false);
      onDownload();
    }
  }, [pendingFullQualityDownload, isUpdating, currentRenderQuality, onDownload]);

  const handlePromptOpenChange = (open: boolean) => {
    if (!open) {
      setUpdatePromptReason(null);
    }
  };

  const showUpdatePrompt = updatePromptReason !== null;
  const promptCopy =
    updatePromptReason === 'audio'
      ? {
          title: 'Update video to mix your audio',
          description: 'We need to restitch the clips with the uploaded track so you can preview it.',
        }
      : updatePromptReason === 'loop'
      ? {
          title: 'Update video to apply your loop count',
          description: 'Duplicated clips require a fresh render to reflect easing or duration tweaks.',
        }
      : {
          title: '',
          description: '',
        };

  // Render Components
  const isPreviewRender = currentRenderQuality === 'preview';
  const downloadButtonLabel = pendingFullQualityDownload
    ? 'Rendering Full Quality...'
    : isPreviewRender
    ? 'Download (Render Full Quality)'
    : 'Download';

  const ExportButtons = (
    <div className="flex gap-2">
      <Button onClick={onExit} variant="outline" className="flex-1" disabled={isUpdating}>
        Exit
      </Button>
      <Button onClick={handleDownload} className="flex-1 gap-2" disabled={isUpdating}>
        {isUpdating && pendingFullQualityDownload ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        {downloadButtonLabel}
      </Button>
    </div>
  );

  const AudioSettingsContent = (
    <div className="space-y-6">
      <div>
        <h4 className="text-2xl font-bold text-foreground">Audio Settings</h4>
        <p className="text-xs text-muted-foreground">
          Shape fade envelopes and looping for the background track.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="audio-fade-in">Fade in (sec)</Label>
        <div className="flex items-center gap-3">
          <input
            id="audio-fade-in"
            type="range"
            min={0}
            max={10}
            step={0.1}
            value={audioSettings.fadeIn}
            onChange={(event) => updateAudioSetting('fadeIn', Number(event.target.value))}
            className="h-2 flex-1 cursor-pointer rounded-full bg-primary/30"
          />
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={audioSettings.fadeIn}
            onChange={(event) => updateAudioSetting('fadeIn', Number(event.target.value))}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="audio-fade-out">Fade out (sec)</Label>
        <div className="flex items-center gap-3">
          <input
            id="audio-fade-out"
            type="range"
            min={0}
            max={10}
            step={0.1}
            value={audioSettings.fadeOut}
            onChange={(event) => updateAudioSetting('fadeOut', Number(event.target.value))}
            className="h-2 flex-1 cursor-pointer rounded-full bg-primary/30"
          />
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={audioSettings.fadeOut}
            onChange={(event) => updateAudioSetting('fadeOut', Number(event.target.value))}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="audio-update-quality" className="text-sm text-muted-foreground whitespace-nowrap">
          Quality:
        </label>
        <select
          id="audio-update-quality"
          value={renderQuality}
          onChange={(e) => onRenderQualityChange(e.target.value as RenderQuality)}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="full">Full Quality</option>
          <option value="preview">Preview (720p)</option>
        </select>
      </div>
      <Button
        size="sm"
        onClick={() => handleVideoUpdate()}
        disabled={isUpdating}
        className="gap-2 w-full"
      >
        {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
        {isUpdating ? 'Updating.' : 'Update Video'}
      </Button>
    </div>
  );

  const SegmentSettingsContent = selectedSegment ? (
    <>
      <div>
        <div className="flex items-center gap-3">
          <h4 className="text-2xl font-bold text-foreground">{selectedSegment.name}</h4>
          {selectedSegment.loopIteration && selectedSegment.loopIteration > 1 && (
            <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Loop {selectedSegment.loopIteration}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Fine-tune duration and easing curve.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="segment-duration">Duration (sec)</Label>
        <div className="flex items-center gap-3">
          <input
            id="segment-duration"
            type="range"
            min={0.5}
            max={6}
            step={0.1}
            value={selectedSegment.duration ?? 1.5}
            onChange={(event) =>
              onDurationChange(selectedSegment.id, Number(event.target.value), applyAll)
            }
            className="h-2 flex-1 cursor-pointer rounded-full bg-primary/30"
          />
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={(selectedSegment.duration ?? 1.5).toFixed(2)}
            onChange={(event) =>
              onDurationChange(selectedSegment.id, Number(event.target.value), applyAll)
            }
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Label>Ease Curve</Label>
          <select
            id="preset-select"
            value={selectedSegment.easingPreset ?? ''}
            onChange={(event) => onPresetChange(selectedSegment.id, event.target.value, applyAll)}
            className="rounded-md border border-border bg-background py-2 pl-3 pr-8 text-sm"
          >
            {easingOptions.map((preset) => (
              <option key={preset} value={preset}>
                {preset}
              </option>
            ))}
          </select>
        </div>
        <CubicBezierEditor
          value={curveValue}
          onChange={handleBezierChange}
          onCommit={handleBezierCommit}
        />
        <p className="text-xs text-muted-foreground">
          Drag the control points to sculpt a bespoke ease-in/ease-out profile for this segment.
        </p>
      </div>

      <div className="space-y-2 pt-2">
        <label className="flex items-center gap-2 text-sm text-foreground/90">
          <input
            type="checkbox"
            checked={applyAll}
            onChange={(event) => {
              const nextValue = event.target.checked;
              setApplyAll(nextValue);
              if (nextValue && selectedSegment) {
                onCloneSegmentSettings(selectedSegment.id);
              }
            }}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          Apply settings to all videos
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground mt-4">
          <input
            type="checkbox"
            checked={renderQuality === 'preview'}
            onChange={(e) => onRenderQualityChange(e.target.checked ? 'preview' : 'full')}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          Render previews in lower quality (faster)
        </label>
        <Button
          size="sm"
          onClick={() => handleVideoUpdate()}
          disabled={isUpdating}
          className="gap-2 w-full mt-2"
        >
          {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
          {isUpdating ? 'Updating…' : 'Update Video'}
        </Button>
      </div>
    </>
  ) : (
    <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
      <p>Select a segment in the timeline to edit its timing and ease curve.</p>
    </div>
  );

  return (
    <>
      <div className="w-full h-full flex flex-col lg:flex-row gap-2 lg:gap-6 max-w-[1800px] mx-auto">
        <div className="flex-1 flex flex-col gap-3 lg:gap-6 min-w-0">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black shadow-xl">
            <video
              key={finalVideo.url}
              ref={videoRef}
              src={finalVideo.url}
              loop
              className="h-full w-full"
              preload="metadata"
            />
          </div>

          {/* Playback Controls */}
          <div className="px-1 lg:px-2">
            <VideoPlaybackControls
              isPlaying={state.isPlaying}
              currentTime={state.currentTime}
              duration={state.duration}
              onPlayPause={togglePlayPause}
              videoSize={finalVideo.size}
              createdAt={finalVideo.createdAt}
              actions={
                <div className="flex flex-wrap items-center gap-2 md:gap-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <label className="flex items-center gap-1.5 md:gap-2">
                    <span>Loops</span>
                    <select
                      value={loopCount}
                      onChange={handleLoopDropdownChange}
                      className="rounded-md border border-border bg-background py-1 pl-1 pr-4 md:pl-2 md:pr-6 text-[10px] md:text-[11px] font-semibold uppercase tracking-widest text-foreground"
                    >
                      {LOOP_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          x{option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex items-center gap-2 md:gap-4">
                    <span className="hidden md:inline">Zoom</span>
                    <TimelineZoomSlider
                      disabled={timelineZoomDisabled}
                      value={timelineZoom}
                      onValueChange={setTimelineZoom}
                    />
                  </div>
                </div>
              }
            />
          </div>

          {/* Timeline */}
          <div className="px-1 lg:px-2">
            <VideoTimeline
              segments={segments}
              currentTime={state.currentTime}
              selectedSegmentId={selectedSegmentId}
              onSeek={seek}
              onSegmentSelect={handleSegmentSelect}
              zoomValue={timelineZoom}
              onZoomChange={setTimelineZoom}
              renderAudioTrack={({ trackWidth, pixelsPerSecond, totalDuration }) => (
                <div className="space-y-1">
                  {!waveformData ? (
                    <AudioUploadBox onAudioSelect={handleAudioSelect} disabled={isAudioLoading} />
                  ) : (
                    <AudioWaveformVisualization
                      waveformData={waveformData}
                      fileName={audioFile?.name || 'Audio Track'}
                      isLoading={isAudioLoading}
                      onRemove={handleRemoveAudio}
                      currentTime={state.currentTime}
                      timelineDuration={totalDuration}
                      onSelect={handleAudioTrackSelect}
                      isSelected={inspectorView === 'audio'}
                      trackWidth={trackWidth}
                      pixelsPerSecond={pixelsPerSecond}
                    />
                  )}
                </div>
              )}
            />
          </div>
        </div>

        <aside className="flex flex-col w-full lg:w-[400px] xl:w-[450px] shrink-0 rounded-xl border border-border bg-secondary/30 p-6 h-auto lg:h-full lg:sticky lg:top-6">
          <Tabs
            value={inspectorView}
            onValueChange={(v) => setInspectorView(v as 'segments' | 'audio' | 'export')}
            className="flex flex-col h-full w-full"
          >
              <TabsList className="grid w-full grid-cols-3 lg:hidden mb-4 bg-secondary/50 p-1 rounded-xl">
                <TabsTrigger 
                  value="segments" 
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all duration-200"
                >
                  Clip
                </TabsTrigger>
                <TabsTrigger 
                  value="audio" 
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all duration-200"
                >
                  Audio
                </TabsTrigger>
                <TabsTrigger 
                  value="export" 
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all duration-200"
                >
                  Export
                </TabsTrigger>
              </TabsList>

            <div className="flex-1 overflow-y-auto min-h-[400px] lg:min-h-0">
              <TabsContent value="segments" className="mt-0 h-full space-y-4 data-[state=inactive]:hidden">
                {SegmentSettingsContent}
              </TabsContent>

              <TabsContent value="audio" className="mt-0 h-full space-y-4 data-[state=inactive]:hidden">
                {waveformData ? (
                  AudioSettingsContent
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    <p>Upload an audio track in the timeline to configure audio settings.</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="export" className="mt-0 h-full flex items-center justify-center lg:hidden data-[state=inactive]:hidden">
                <div className="w-full space-y-4">
                  <p className="text-center text-sm text-muted-foreground mb-4">Ready to save your loop?</p>
                  {ExportButtons}
                </div>
              </TabsContent>
            </div>
          </Tabs>

          {/* Desktop Footer (Always visible on desktop) */}
          <div className="hidden lg:block border-t border-border/60 pt-4 mt-4">
            {ExportButtons}
          </div>
        </aside>
      </div>

      <Dialog open={showUpdatePrompt} onOpenChange={handlePromptOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{promptCopy.title}</DialogTitle>
            <DialogDescription>{promptCopy.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdatePromptReason(null)} disabled={isUpdating}>
              Later
            </Button>
            <Button onClick={handleVideoUpdate} disabled={isUpdating} className="gap-2">
              {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
              Update video
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
