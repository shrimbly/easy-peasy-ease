'use client';

import { ChangeEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FinalVideo, TransitionVideo, AudioProcessingOptions, RenderQuality, UpdateReason } from '@/lib/types';
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
import { Download, Loader2 } from 'lucide-react';
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
import {
  alignOffsetToBeatGrid,
  quantizeOffsetToNearestBeat,
  snapDurationsToBeatGrid,
  type BeatSubdivision,
} from '@/lib/beat-sync';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RangeSlider } from '@/components/ui/range-slider';
import { EasingCurvePicker } from '@/components/ui/easing-curve-picker';
import { getVideoPreviewAspectRatio } from '@/lib/video-preview';

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
  /** Copies the segment's settings to all segments; returns the resulting
   *  segment list so an immediate re-render can use it (parent state updates
   *  are async, so reading `segments` right after cloning would be stale). */
  onCloneSegmentSettings: (id: number) => TransitionVideo[] | undefined;
  onUpdateVideo: (options?: { audioBlob?: Blob; audioSettings?: AudioProcessingOptions; quality?: RenderQuality; updateHint?: UpdateReason; segments?: TransitionVideo[] }) => void;
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
  // Which update CTA was pressed last — used to place the busy spinner.
  const [updateScope, setUpdateScope] = useState<'section' | 'all'>('all');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [inspectorView, setInspectorView] = useState<'segments' | 'audio' | 'export'>('segments');
  const [audioSettings, setAudioSettings] = useState<AudioProcessingOptions>({
    fadeIn: 0.5,
    fadeOut: 0.5,
    offset: 0,
  });
  const [updatePromptReason, setUpdatePromptReason] = useState<'loop' | 'audio' | null>(null);
  const [pendingFullQualityDownload, setPendingFullQualityDownload] = useState(false);
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
  const previewAspectRatio = useMemo(() => {
    const firstSegment = segments[0];
    return getVideoPreviewAspectRatio(firstSegment?.width, firstSegment?.height);
  }, [segments]);
  const timelineZoomDisabled =
    totalTimelineDuration === 0 || totalTimelineDuration <= TIMELINE_MIN_VISIBLE_SECONDS;

  // Audio visualization
  const { waveformData, isLoading: isAudioLoading } = useAudioVisualization(audioFile);

  // Beat snapping. A subdivision toggle applies suggested durations (every
  // Nth beat) immediately to the staged segment state and beat-aligns the
  // audio offset; toggling off restores the pre-snap baseline. Only the
  // timeline updates live — rendering stays an explicit action, like manual
  // duration edits.
  const beatAnalysis = waveformData?.beats ?? null;
  const [beatSubdivision, setBeatSubdivision] = useState<BeatSubdivision | 0>(0);
  const preSnapRef = useRef<{ durations: Map<number, number>; offset: number } | null>(null);

  // A different track means a different grid: drop the toggle and baseline
  // (current durations stay — they may already be rendered into the video).
  const resetBeatSnap = useCallback(() => {
    setBeatSubdivision(0);
    preSnapRef.current = null;
  }, []);

  const handleBeatSubdivisionChange = useCallback(
    (next: BeatSubdivision | 0) => {
      if (!beatAnalysis) return;

      if (next === 0) {
        const baseline = preSnapRef.current;
        if (baseline) {
          segments.forEach((segment) => {
            const original = baseline.durations.get(segment.id);
            if (original !== undefined) {
              onDurationChange(segment.id, original);
            }
          });
          setAudioSettings((prev) => ({ ...prev, offset: baseline.offset }));
          // If a render happened while snapped, the restored offset no longer
          // matches the rendered audio — raise the same update prompt an
          // offset drag does.
          if (baseline.offset !== prevAudioSettingsRef.current.offset) {
            setUpdatePromptReason('audio');
          }
        }
        preSnapRef.current = null;
        setBeatSubdivision(0);
        return;
      }

      // Snap from the baseline captured when snapping was first engaged, so
      // switching 1 → 2 → 4 re-suggests from the user's own durations rather
      // than compounding earlier snaps.
      const baseline = preSnapRef.current ?? {
        durations: new Map(segments.map((s) => [s.id, s.duration ?? 1.5])),
        offset: audioSettings.offset,
      };
      preSnapRef.current = baseline;

      const baseDurations = segments.map(
        (s) => baseline.durations.get(s.id) ?? s.duration ?? 1.5
      );
      const snapped = snapDurationsToBeatGrid(baseDurations, beatAnalysis.bpm, next);
      segments.forEach((segment, index) => {
        onDurationChange(segment.id, snapped[index]);
      });
      setAudioSettings((prev) => ({
        ...prev,
        offset: alignOffsetToBeatGrid(baseline.offset, beatAnalysis),
      }));
      setBeatSubdivision(next);
    },
    [audioSettings.offset, beatAnalysis, onDurationChange, segments]
  );

  // A manual duration edit diverges from the applied suggestion, so the
  // toggle switches off (the edit stands; only the "on the grid" claim ends).
  const handleManualDurationChange = useCallback(
    (id: number, duration: number, applyAll?: boolean) => {
      if (beatSubdivision !== 0) {
        resetBeatSnap();
      }
      onDurationChange(id, duration, applyAll);
    },
    [beatSubdivision, onDurationChange, resetBeatSnap]
  );

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
      scheduleBezierChange(selectedSegment.id, nextValue, false);
    },
    [scheduleBezierChange, selectedSegment]
  );

  const handleBezierCommit = useCallback(
    (finalValue: [number, number, number, number]) => {
      if (!selectedSegment) return;
      setLocalCurve(finalValue);
      flushPendingBezier({
        segmentId: selectedSegment.id,
        bezier: finalValue,
        applyAll: false,
      });
    },
    [flushPendingBezier, selectedSegment]
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
    // Auto-select segment based on playback position. Deliberately not
    // handleSegmentSelect: playback must not switch the inspector tab away
    // from Audio/Export at every segment boundary.
    const currentSegment = getCurrentSegment(currentTime, segments);
    if (currentSegment && currentSegment.id !== selectedSegmentId) {
      onSelectSegment(currentSegment.id);
    }
  });

  const handleAudioSelect = useCallback((file: File) => {
    setAudioFile(file);
    resetBeatSnap();
    audioFileChangedRef.current = true;
    setUpdatePromptReason('audio');
  }, [resetBeatSnap]);

  const handleRemoveAudio = useCallback(() => {
    setAudioFile(null);
    resetBeatSnap();
    if (inspectorView === 'audio') {
      setInspectorView('segments');
    }
  }, [inspectorView, resetBeatSnap]);

  const handleAudioTrackSelect = useCallback(() => {
    if (!waveformData) return;
    setInspectorView('audio');
  }, [waveformData]);

  const handleAudioOffsetChange = useCallback(
    (newOffset: number) => {
      // While snapping is active a free drag would silently pull the beats
      // off the section boundaries; make the drag magnetic instead — commit
      // to the nearest beat so the grid claim stays true. The baseline moves
      // with it: toggle-off then reverts durations but keeps the new position.
      const committed =
        beatSubdivision !== 0 && beatAnalysis
          ? quantizeOffsetToNearestBeat(newOffset, beatAnalysis)
          : newOffset;
      if (preSnapRef.current && beatSubdivision !== 0) {
        preSnapRef.current = { ...preSnapRef.current, offset: committed };
      }
      setAudioSettings((prev) => ({
        ...prev,
        offset: committed,
      }));
    },
    [beatAnalysis, beatSubdivision]
  );

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
      // Loop sync clones/removes segments under ids the pre-snap baseline
      // doesn't cover, so a later toggle-off could only half-restore. Drop
      // the toggle and baseline; the (uniformly snapped) durations stand.
      if (beatSubdivision !== 0) {
        resetBeatSnap();
      }
      onLoopCountChange(nextValue);
      setUpdatePromptReason('loop');
    },
    [beatSubdivision, loopCount, onLoopCountChange, resetBeatSnap]
  );

  const handleVideoUpdate = (
    qualityOverride?: RenderQuality,
    segmentsOverride?: TransitionVideo[]
  ) => {
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

    // Audio-only changes must not re-encode the video at a different quality:
    // that would both downgrade the current result (e.g. after a full-quality
    // download while the preview toggle is still on) and defeat the fast/medium
    // reuse paths, which are keyed on quality. Preserve the quality the current
    // video was actually rendered at; the toggle only governs full re-renders.
    const isAudioOnly = updateHint === 'audio-file' || updateHint === 'audio-fade';
    const effectiveQuality =
      qualityOverride ?? (isAudioOnly ? currentRenderQuality ?? renderQuality : renderQuality);

    onUpdateVideo({
      audioBlob: audioFile ?? undefined,
      audioSettings,
      quality: effectiveQuality,
      updateHint,
      segments: segmentsOverride,
    });
    setUpdatePromptReason(null);
  };

  const handleUpdateSection = () => {
    setUpdateScope('section');
    handleVideoUpdate();
  };

  const handleUpdateAllSections = () => {
    if (!selectedSegment) return;
    setUpdateScope('all');
    // Cloning one section's settings onto all of them overwrites any
    // per-section beat-snapped durations — the snap claim no longer holds.
    if (beatSubdivision !== 0) {
      resetBeatSnap();
    }
    // Clone returns the post-clone list so the re-render below doesn't read
    // the parent's still-stale segment state.
    const nextSegments = onCloneSegmentSettings(selectedSegment.id);
    handleVideoUpdate(undefined, nextSegments);
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
  const downloadButtonLabel = pendingFullQualityDownload ? 'Rendering…' : 'Download';

  const ExportButtons = (
    <div className="flex gap-2">
      <Button onClick={onExit} variant="outline" className="flex-1" disabled={isUpdating}>
        Exit
      </Button>
      <Button
        onClick={handleDownload}
        className="flex-1 gap-2 bg-white text-neutral-950 hover:bg-white/90"
        disabled={isUpdating}
      >
        {isUpdating && pendingFullQualityDownload ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        {downloadButtonLabel}
      </Button>
    </div>
  );

  const AudioSettingsContent = (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h4 className="text-xl lg:text-2xl font-bold text-foreground">Audio Settings</h4>
        <p className="hidden sm:block text-xs text-muted-foreground">
          Shape fade envelopes and looping for the background track.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="audio-fade-in">Fade in (sec)</Label>
        <div className="flex items-center gap-3">
          <RangeSlider
            id="audio-fade-in"
            min={0}
            max={10}
            step={0.1}
            value={audioSettings.fadeIn}
            onChange={(event) => updateAudioSetting('fadeIn', Number(event.target.value))}
            className="flex-1"
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
          <RangeSlider
            id="audio-fade-out"
            min={0}
            max={10}
            step={0.1}
            value={audioSettings.fadeOut}
            onChange={(event) => updateAudioSetting('fadeOut', Number(event.target.value))}
            className="flex-1"
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
          <h4 className="text-xl lg:text-2xl font-bold text-foreground">{selectedSegment.name}</h4>
          {selectedSegment.loopIteration && selectedSegment.loopIteration > 1 && (
            <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Loop {selectedSegment.loopIteration}
            </span>
          )}
        </div>
        <p className="hidden sm:block text-xs text-muted-foreground">Fine-tune duration and easing curve.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="segment-duration">Duration (sec)</Label>
        <div className="flex items-center gap-3">
          <RangeSlider
            id="segment-duration"
            // Snapped values can leave 0.5–6; widen so the DOM never clamps
            // (a pinned thumb would misreport and re-clamp on first keypress).
            min={Math.min(0.5, selectedSegment.duration ?? 1.5)}
            max={Math.max(6, selectedSegment.duration ?? 1.5)}
            step={0.01}
            value={selectedSegment.duration ?? 1.5}
            onChange={(event) =>
              handleManualDurationChange(selectedSegment.id, Number(event.target.value))
            }
            className="flex-1"
          />
          <input
            type="number"
            min={0.1}
            step={0.01}
            value={(selectedSegment.duration ?? 1.5).toFixed(2)}
            onChange={(event) =>
              handleManualDurationChange(selectedSegment.id, Number(event.target.value))
            }
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
      </div>

      <div className="space-y-3 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <div className="flex items-center justify-between gap-2">
          <Label>Ease Curve</Label>
          <EasingCurvePicker
            id="preset-select"
            value={selectedSegment.easingPreset ?? easingOptions[0]}
            options={easingOptions}
            onChange={(preset) => onPresetChange(selectedSegment.id, preset)}
            disabled={isUpdating}
          />
        </div>
        {/* max-h = plot-square cap (sidebar inner width) + readout row, so the
            plot never stretches past square and spare space falls below. */}
        <CubicBezierEditor
          value={curveValue}
          onChange={handleBezierChange}
          onCommit={handleBezierCommit}
          className="lg:min-h-0 lg:flex-1 lg:max-h-[338px] xl:max-h-[378px]"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleUpdateSection}
            disabled={isUpdating}
            className="flex-1 gap-2"
          >
            {isUpdating && updateScope === 'section' && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Update Section
          </Button>
          <Button
            size="sm"
            onClick={handleUpdateAllSections}
            disabled={isUpdating}
            className="flex-1 gap-2"
          >
            {isUpdating && updateScope === 'all' && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Update All Sections
          </Button>
        </div>
      </div>

      <div className="pt-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={renderQuality === 'preview'}
            onChange={(e) => onRenderQualityChange(e.target.checked ? 'preview' : 'full')}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          Render previews in lower quality (faster)
        </label>
      </div>
    </>
  ) : (
    <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
      <p>Select a segment in the timeline to edit its timing and ease curve.</p>
    </div>
  );

  return (
    <>
      {/* On lg the editor fills the viewport (minus the 8px page frame); the
          video preview flexes to absorb the height and letterboxes itself. */}
      <div className="w-full flex flex-col lg:flex-row gap-2 max-w-[1800px] mx-auto lg:h-[calc(100vh-1rem)]">
        <div className="flex-1 flex flex-col gap-3 lg:gap-6 min-w-0 lg:min-h-0">
          {/* Preview, controls bar and timeline as one connected card */}
          <div className="flex w-full flex-col shadow-xl lg:h-full lg:min-h-0">
            <div
              className="relative flex w-full items-center justify-center overflow-hidden rounded-t-xl border border-border bg-black lg:!aspect-auto lg:flex-1 lg:min-h-0"
              style={{ aspectRatio: previewAspectRatio }}
            >
              <video
                key={finalVideo.url}
                ref={videoRef}
                src={finalVideo.url}
                loop
                playsInline
                className="h-full w-full object-contain"
                preload="metadata"
              />
            </div>

          {/* Controls bar bridging the preview and the timeline */}
          <div className="border-x border-border bg-secondary px-3 py-2">
            <VideoPlaybackControls
              isPlaying={state.isPlaying}
              currentTime={state.currentTime}
              duration={state.duration}
              onPlayPause={togglePlayPause}
              videoSize={finalVideo.size}
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
            <VideoTimeline
              segments={segments}
              currentTime={state.currentTime}
              selectedSegmentId={selectedSegmentId}
              onSeek={seek}
              onSegmentSelect={handleSegmentSelect}
              zoomValue={timelineZoom}
              onZoomChange={setTimelineZoom}
              viewportClassName="rounded-t-none rounded-b-xl"
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
                      beatSubdivision={beatSubdivision}
                      onBeatSubdivisionChange={handleBeatSubdivisionChange}
                      onBeatApply={() => handleVideoUpdate()}
                      isBeatUpdating={isUpdating}
                    />
                  )}
                </div>
              )}
            />
          </div>
        </div>

        {/* The wrapper cell contributes no height on lg (the aside is an
            absolute overlay), so the row's height — and therefore the
            sidebar's — is set by the preview/timeline column. */}
        <div className="w-full lg:w-[360px] xl:w-[400px] shrink-0 lg:relative">
        <aside className="flex flex-col rounded-xl border border-border bg-secondary p-4 lg:p-6 lg:absolute lg:inset-0">
          <Tabs
            value={inspectorView}
            onValueChange={(v) => setInspectorView(v as 'segments' | 'audio' | 'export')}
            className="flex flex-col h-full w-full"
          >
              <TabsList className="grid w-full grid-cols-3 mb-3 bg-secondary/50 p-1 rounded-xl">
                <TabsTrigger 
                  value="segments" 
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-[color,background-color,box-shadow] duration-200"
                >
                  Clip
                </TabsTrigger>
                <TabsTrigger 
                  value="audio" 
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-[color,background-color,box-shadow] duration-200"
                >
                  Audio
                </TabsTrigger>
                <TabsTrigger 
                  value="export" 
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-[color,background-color,box-shadow] duration-200"
                >
                  Export
                </TabsTrigger>
              </TabsList>

            <div className="flex-1 overflow-y-auto min-h-[400px] lg:min-h-0">
              <TabsContent value="segments" className="mt-0 h-full space-y-3 sm:space-y-4 lg:flex lg:flex-col data-[state=inactive]:hidden">
                {SegmentSettingsContent}
              </TabsContent>

              <TabsContent value="audio" className="mt-0 h-full space-y-3 sm:space-y-4 data-[state=inactive]:hidden">
                {waveformData ? (
                  AudioSettingsContent
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    <p>Upload an audio track in the timeline to configure audio settings.</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="export" className="mt-0 h-full flex items-center justify-center data-[state=inactive]:hidden">
                <div className="w-full space-y-4">
                  <p className="text-center text-sm text-muted-foreground mb-4">Ready to save your loop?</p>
                  {ExportButtons}
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </aside>
        </div>
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
            <Button onClick={() => handleVideoUpdate()} disabled={isUpdating} className="gap-2">
              {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
              Update video
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
