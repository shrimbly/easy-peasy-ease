'use client';

import { useState } from 'react';
import { FinalVideo, TransitionVideo, AudioProcessingOptions } from '@/lib/types';
import { Label } from '@/components/ui/label';
import { CubicBezierEditor } from '@/components/CubicBezierEditor';
import { Button } from '@/components/ui/button';
import { Loader2, Play } from 'lucide-react';
import { getPresetBezier } from '@/lib/easing-presets';
import { useVideoPlayback } from '@/hooks/useVideoPlayback';
import { VideoPlaybackControls } from '@/components/VideoPlaybackControls';
import { VideoTimeline } from '@/components/VideoTimeline';
import { getCurrentSegment } from '@/lib/timeline-utils';
import { AudioUploadBox } from '@/components/AudioUploadBox';
import { AudioWaveformVisualization } from '@/components/AudioWaveformVisualization';
import { useAudioVisualization } from '@/hooks/useAudioVisualization';

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
  onUpdateVideo: (options?: { audioBlob?: Blob; audioSettings?: AudioProcessingOptions }) => void;
  isUpdating: boolean;
  onExit: () => void;
  onDownload: () => void;
}

export function FinalVideoEditor({
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
}: FinalVideoEditorProps) {
  const selectedSegment = segments.find((segment) => segment.id === selectedSegmentId) ?? null;
  const [applyAll, setApplyAll] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [inspectorView, setInspectorView] = useState<'segments' | 'audio'>('segments');
  const [audioSettings, setAudioSettings] = useState<AudioProcessingOptions>({
    fadeIn: 0.5,
    fadeOut: 0.5,
    loopTwice: false,
  });

  // Audio visualization
  const { waveformData, isLoading: isAudioLoading } = useAudioVisualization(audioFile);

  const handleSegmentSelect = (segmentId: number) => {
    setInspectorView('segments');
    onSelectSegment(segmentId);
  };

  // Video playback control
  const { videoRef, state, togglePlayPause, seek } = useVideoPlayback((currentTime) => {
    // Auto-select segment based on playback position
    const currentSegment = getCurrentSegment(currentTime, segments);
    if (currentSegment && currentSegment.id !== selectedSegmentId) {
      handleSegmentSelect(currentSegment.id);
    }
  });

  const handleAudioSelect = (file: File) => {
    setAudioFile(file);
  };

  const handleRemoveAudio = () => {
    setAudioFile(null);
    if (inspectorView === 'audio') {
      setInspectorView('segments');
    }
  };

  const handleAudioTrackSelect = () => {
    if (!waveformData) return;
    setInspectorView('audio');
  };

  const updateAudioSetting = (property: 'fadeIn' | 'fadeOut', value: number) => {
    const sanitizedValue = Number.isNaN(value) ? 0 : value;
    setAudioSettings((prev) => ({
      ...prev,
      [property]: Math.min(Math.max(sanitizedValue, 0), 10),
    }));
  };

  return (
    <div className="w-full space-y-6">
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6 min-w-0">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
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
          <div>
            <VideoPlaybackControls
              isPlaying={state.isPlaying}
              currentTime={state.currentTime}
              duration={state.duration}
              onPlayPause={togglePlayPause}
              videoSize={finalVideo.size}
              createdAt={finalVideo.createdAt}
            />
          </div>

          {/* Timeline */}
          <div>
            <VideoTimeline
              segments={segments}
              currentTime={state.currentTime}
              selectedSegmentId={selectedSegmentId}
              onSeek={seek}
              onSegmentSelect={handleSegmentSelect}
              renderAudioTrack={({ trackWidth }) => (
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
                      duration={state.duration}
                      onSelect={handleAudioTrackSelect}
                      isSelected={inspectorView === 'audio'}
                      trackWidth={trackWidth}
                    />
                  )}
                </div>
              )}
            />
          </div>
        </div>

        <aside className="flex flex-col rounded-xl border border-border bg-secondary/30 p-6 h-full">
          <div className="space-y-4 flex-1">
            {inspectorView === 'audio' && waveformData ? (
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

                <div className="space-y-3 rounded-lg border border-border/70 bg-muted/10 p-4">
                  <label className="flex items-center gap-3 text-sm font-medium text-foreground/90">
                    <input
                      type="checkbox"
                      checked={audioSettings.loopTwice}
                      onChange={(event) =>
                        setAudioSettings((prev) => ({ ...prev, loopTwice: event.target.checked }))
                      }
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    Loop video twice with continuous music
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Ensures the final render plays two seamless orbits while the uploaded track keeps
                    playing without restarting.
                  </p>
                </div>

                <Button
                  size="sm"
                  onClick={() =>
                    onUpdateVideo({
                      audioBlob: audioFile ?? undefined,
                      audioSettings,
                    })
                  }
                  disabled={isUpdating}
                  className="gap-2 w-full"
                >
                  {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isUpdating ? 'Updating.' : 'Update Video'}
                </Button>
              </div>
            ) : selectedSegment ? (
              (() => {
                const curveValue =
                  selectedSegment.customBezier ??
                  getPresetBezier(selectedSegment.easingPreset ?? null) ??
                  defaultBezier;
                return (
                  <>
                    <div>
                      <h4 className="text-2xl font-bold text-foreground">
                        {selectedSegment.name}
                      </h4>
                      <p className="text-xs text-muted-foreground">
                    Fine-tune duration and easing curve.
                  </p>
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
                      onChange={(event) =>
                        onPresetChange(selectedSegment.id, event.target.value, applyAll)
                      }
                      className="rounded-md border border-border bg-background px-3 py-2 text-sm"
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
                    onChange={(nextValue) => onBezierChange(selectedSegment.id, nextValue, applyAll)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Drag the control points to sculpt a bespoke ease-in/ease-out profile for this
                    segment.
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
                  <Button
                    size="sm"
                    onClick={() =>
                      onUpdateVideo({
                        audioBlob: audioFile ?? undefined,
                        audioSettings,
                      })
                    }
                    disabled={isUpdating}
                    className="gap-2 w-full mt-2"
                  >
                    {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
                    {isUpdating ? 'Updating…' : 'Update Video'}
                  </Button>
                </div>
                  </>
                );
              })()
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <p>Select a segment in the timeline to edit its timing and ease curve.</p>
              </div>
            )}
          </div>

          <div className="border-t border-border/60 pt-4 mt-4">
            <div className="flex gap-2">
              <Button
                onClick={onExit}
                variant="outline"
                className="flex-1"
              >
                Exit
              </Button>
              <Button
                onClick={onDownload}
                className="flex-1 gap-2"
              >
                <Play className="h-4 w-4" />
                Download
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}


