'use client';

import { ChangeEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FinalVideo, TransitionVideo, AudioProcessingOptions, UpdateReason } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Play } from 'lucide-react';
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
import { QualityRating } from '@/components/QualityRating';
import { UpdatePromptDialog } from '@/components/UpdatePromptDialog';
import { AudioSettingsPanel } from '@/components/AudioSettingsPanel';
import { SegmentSettingsPanel } from '@/components/SegmentSettingsPanel';

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
  onUpdateVideo: (options?: { audioBlob?: Blob; audioSettings?: AudioProcessingOptions; updateHint?: UpdateReason }) => void;
  isUpdating: boolean;
  onExit: () => void;
  onDownload: () => void;
  loopCount: number;
  onLoopCountChange: (next: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
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
  onReorder,
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
    offset: 0,
  });
  const [updatePromptReason, setUpdatePromptReason] = useState<'loop' | 'audio' | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(0);

  // Refs for tracking what changed to determine update path
  const prevAudioFileRef = useRef<File | null>(null);
  const prevAudioSettingsRef = useRef<AudioProcessingOptions>({ fadeIn: 0.5, fadeOut: 0.5, offset: 0 });
  const audioFileChangedRef = useRef(false);
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
    audioFileChangedRef.current = true;
    setUpdatePromptReason('audio');
  }, []);

  const handleRemoveAudio = useCallback(() => {
    setAudioFile(null);
    audioFileChangedRef.current = true;
    setUpdatePromptReason('audio');
    if (inspectorView === 'audio') {
      setInspectorView('segments');
    }
  }, [inspectorView]);

  const handleAudioTrackSelect = useCallback(() => {
    if (!waveformData) return;
    setInspectorView('audio');
  }, [waveformData]);

  const handleAudioOffsetChange = useCallback((newOffset: number) => {
    setAudioSettings((prev) => ({
      ...prev,
      offset: newOffset,
    }));
  }, []);

  const handleAudioOffsetCommit = useCallback(() => {
    setUpdatePromptReason('audio');
  }, []);

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

  const handleVideoUpdate = () => {
    // Determine update hint based on what changed
    let updateHint: UpdateReason | undefined;

    if (audioFileChangedRef.current) {
      // Audio file was changed - use medium path
      updateHint = 'audio-file';
    } else if (
      audioFile &&
      prevAudioFileRef.current === audioFile &&
      audioSettings.offset !== prevAudioSettingsRef.current.offset
    ) {
      // Offset changed - needs re-stitch (medium path)
      updateHint = 'audio-file';
    } else if (
      audioFile &&
      prevAudioFileRef.current === audioFile &&
      (audioSettings.fadeIn !== prevAudioSettingsRef.current.fadeIn ||
        audioSettings.fadeOut !== prevAudioSettingsRef.current.fadeOut)
    ) {
      // Only fade settings changed - use fast path
      updateHint = 'audio-fade';
    }

    // Update refs for next comparison
    prevAudioFileRef.current = audioFile;
    prevAudioSettingsRef.current = { ...audioSettings };
    audioFileChangedRef.current = false;

    onUpdateVideo({
      audioBlob: audioFile ?? undefined,
      audioSettings,
      updateHint,
    });
    setUpdatePromptReason(null);
  };

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
  const ExportButtons = (
    <div className="flex gap-2">
      <Button onClick={onExit} variant="outline" className="flex-1">
        Exit
      </Button>
      <Button onClick={onDownload} className="flex-1 gap-2">
        <Play className="h-4 w-4" />
        Download
      </Button>
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
                  <QualityRating segments={segments} />
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
              onReorder={onReorder}
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
                      offset={audioSettings.offset}
                      onOffsetChange={handleAudioOffsetChange}
                      onOffsetCommit={handleAudioOffsetCommit}
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
                <SegmentSettingsPanel
                  selectedSegment={selectedSegment}
                  easingOptions={easingOptions}
                  applyAll={applyAll}
                  onApplyAllChange={(checked) => {
                    setApplyAll(checked);
                    if (checked && selectedSegment) {
                      onCloneSegmentSettings(selectedSegment.id);
                    }
                  }}
                  onDurationChange={onDurationChange}
                  onPresetChange={onPresetChange}
                  onBezierChange={handleBezierChange}
                  onBezierCommit={handleBezierCommit}
                  curveValue={curveValue}
                  onUpdateVideo={handleVideoUpdate}
                  isUpdating={isUpdating}
                />
              </TabsContent>

              <TabsContent value="audio" className="mt-0 h-full space-y-4 data-[state=inactive]:hidden">
                {waveformData ? (
                  <AudioSettingsPanel
                    audioSettings={audioSettings}
                    onUpdateSetting={updateAudioSetting}
                    onCommit={handleVideoUpdate}
                    isUpdating={isUpdating}
                  />
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

      <UpdatePromptDialog
        open={showUpdatePrompt}
        onOpenChange={handlePromptOpenChange}
        title={promptCopy.title}
        description={promptCopy.description}
        onConfirm={handleVideoUpdate}
        onCancel={() => setUpdatePromptReason(null)}
        isUpdating={isUpdating}
      />
    </>
  );
}
