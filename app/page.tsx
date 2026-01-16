'use client';

import { useState, useCallback, useEffect } from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import { getEncodableVideoCodecs } from 'mediabunny';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { LightRays } from '@/components/ui/light-rays';
import { BlurFade } from '@/components/ui/blur-fade';
import { FinalVideoEditor } from '@/components/FinalVideoEditor';
import { VideoList } from '@/components/VideoList';
import { useFinalizeVideo } from '@/hooks/useFinalizeVideo';
import { useProjectState } from '@/hooks/useProjectState';
import TextPressure from '@/components/text/text-pressure';
import {
  TransitionVideo,
  AudioProcessingOptions,
  UpdateReason,
  PreflightWarning,
  FinalizeContext,
} from '@/lib/types';
import {
  runPreflightChecks,
  formatResolutionLabel,
} from '@/lib/project-service';
import {
  getPresetBezier,
  DEFAULT_EASING,
  EASING_PRESETS,
  DEFAULT_CUSTOM_BEZIER,
} from '@/lib/easing-presets';

type AudioFinalizeOptions = {
  audioBlob?: Blob;
  audioSettings?: AudioProcessingOptions;
  updateHint?: UpdateReason;
};

const cloneSegmentForLoop = (
  segment: TransitionVideo,
  newId: number,
  loopIteration: number
): TransitionVideo => {
  const clonedBezier = segment.customBezier
    ? [...segment.customBezier] as [number, number, number, number]
    : undefined;
  let clonedUrl = segment.url;
  if (segment.cachedBlob) {
    clonedUrl = URL.createObjectURL(segment.cachedBlob);
  } else if (segment.file instanceof Blob) {
    clonedUrl = URL.createObjectURL(segment.file);
  }

  return {
    ...segment,
    id: newId,
    loopIteration,
    customBezier: clonedBezier,
    url: clonedUrl,
  };
};

const ensureLoopIterations = (segments: TransitionVideo[]): TransitionVideo[] =>
  segments.map((segment) =>
    segment.loopIteration
      ? segment
      : {
        ...segment,
        loopIteration: 1,
      }
  );

const syncSegmentsToLoopCount = (
  segments: TransitionVideo[],
  targetLoopCount: number
): TransitionVideo[] => {
  if (segments.length === 0) {
    return segments;
  }

  const normalized = ensureLoopIterations(segments);
  const currentMaxLoop = normalized.reduce(
    (max, segment) => Math.max(max, segment.loopIteration ?? 1),
    1
  );

  if (targetLoopCount <= currentMaxLoop) {
    return normalized.filter(
      (segment) => (segment.loopIteration ?? 1) <= targetLoopCount
    );
  }

  let updatedSegments = [...normalized];
  let loopCursor = currentMaxLoop;
  let nextId = updatedSegments.reduce((max, segment) => Math.max(max, segment.id), 0) + 1;

  while (loopCursor < targetLoopCount) {
    const sourceSegments = updatedSegments.filter(
      (segment) => (segment.loopIteration ?? 1) === loopCursor
    );
    const fallbackSegments = updatedSegments.filter(
      (segment) => (segment.loopIteration ?? 1) === 1
    );
    const segmentsToClone = sourceSegments.length > 0 ? sourceSegments : fallbackSegments;

    const clonedSegments = segmentsToClone.map((segment) =>
      cloneSegmentForLoop(segment, nextId++, loopCursor + 1)
    );

    updatedSegments = [...updatedSegments, ...clonedSegments];
    loopCursor += 1;
  }

  return updatedSegments;
};

export default function Home() {
  const {
    uploadedVideos,
    transitionVideos,
    setTransitionVideos,
    selectedSegmentId,
    setSelectedSegmentId,
    loopCount,
    setLoopCount,
    finalVideo,
    setFinalVideo,
    isFinalizingVideo,
    setIsFinalizingVideo,
    finalizationProgress,
    setFinalizationProgress,
    finalizationMessage,
    setFinalizationMessage,
    speedCurveCache,
    setSpeedCurveCache,
    prevAudioBlobRef,
    prevAudioSettingsRef,
    addVideos,
    resetProject,
    removeVideo,
    updateSegmentMetadata,
    cleanupSegmentResources,
  } = useProjectState();

  const [isDropZoneHovered, setIsDropZoneHovered] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [preflightWarnings, setPreflightWarnings] = useState<PreflightWarning[]>([]);
  const [showPreflightDialog, setShowPreflightDialog] = useState(false);

  useEffect(() => {
    const checkSupport = async () => {
      try {
        const codecs = await getEncodableVideoCodecs();
        if (codecs.length === 0) {
          setIsSupported(false);
        }
      } catch (e) {
        console.warn("WebCodecs support check failed:", e);
        setIsSupported(false);
      }
    };
    checkSupport();
  }, []);

  const { finalizeVideos } = useFinalizeVideo();

  const handleVideosUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      void addVideos(e.target.files, false);
      if (e.target) e.target.value = '';
    },
    [addVideos]
  );

  const handleAddMoreVideos = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      void addVideos(e.target.files, true);
      if (e.target) e.target.value = '';
    },
    [addVideos]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSupported) setIsDropZoneHovered(true);
  }, [isSupported]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropZoneHovered(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDropZoneHovered(false);

      if (!isSupported) return;

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        void addVideos(files, false);
      }
    },
    [isSupported, addVideos]
  );

  const handleSelectSegment = (id: number) => {
    setSelectedSegmentId(id);
  };

  const handleLoopCountChange = (nextLoop: number) => {
    if (nextLoop === loopCount) {
      return;
    }
    setTransitionVideos((prev) => {
      const nextSegments = syncSegmentsToLoopCount(prev, nextLoop);
      const nextIds = new Set(nextSegments.map((segment) => segment.id));
      const removed = prev.filter((segment) => !nextIds.has(segment.id));
      if (removed.length > 0) {
        cleanupSegmentResources(removed);
      }
      if (nextSegments.length === 0) {
        setSelectedSegmentId(null);
      } else if (
        selectedSegmentId === null ||
        !nextSegments.some((segment) => segment.id === selectedSegmentId)
      ) {
        setSelectedSegmentId(nextSegments[0].id);
      }
      return nextSegments;
    });
    setLoopCount(nextLoop);
  };

  const handleSegmentDurationChange = (id: number, duration: number, applyAll = false) => {
    const safeDuration = Number.isFinite(duration) ? Math.max(0.1, duration) : 0.1;
    updateSegmentMetadata(id, { duration: safeDuration }, applyAll);
  };

  const handleSegmentPresetChange = (id: number, preset: string, applyAll = false) => {
    updateSegmentMetadata(
      id,
      {
        easingPreset: preset,
        useCustomEasing: false,
        customBezier: getPresetBezier(preset),
      },
      applyAll
    );
  };

  const handleSegmentBezierChange = (
    id: number,
    bezier: [number, number, number, number],
    applyAll = false
  ) => {
    updateSegmentMetadata(id, { customBezier: bezier, useCustomEasing: true }, applyAll);
  };

  useEffect(() => {
    if (finalVideo && transitionVideos.length > 0 && selectedSegmentId === null) {
      setSelectedSegmentId(transitionVideos[0].id);
    }
  }, [finalVideo, transitionVideos, selectedSegmentId, setSelectedSegmentId]);

  const handleCloneSegmentSettings = (id: number) => {
    const sourceSegment = transitionVideos.find((segment) => segment.id === id);
    if (!sourceSegment) {
      return;
    }

    const sourceCurve =
      sourceSegment.customBezier ??
      getPresetBezier(sourceSegment.easingPreset ?? DEFAULT_EASING);

    setTransitionVideos((prev) =>
      prev.map((segment) => {
        if (segment.id === id) {
          return segment;
        }
        return {
          ...segment,
          duration: sourceSegment.duration,
          easingPreset: sourceSegment.easingPreset,
          useCustomEasing: sourceSegment.useCustomEasing,
          customBezier: [...sourceCurve] as [number, number, number, number],
        };
      })
    );
  };

  const handleReapplyFinalVideo = async (options?: AudioFinalizeOptions) => {
    // Determine update reason based on what changed
    let reason: UpdateReason = 'full';

    if (options?.updateHint) {
      // Use hint from FinalVideoEditor if provided
      reason = options.updateHint;
    } else if (speedCurveCache && finalVideo) {
      // Detect what changed
      // Normalize undefined/null to compare correctly
      const currentAudioBlob = options?.audioBlob ?? null;
      const previousAudioBlob = prevAudioBlobRef.current ?? null;
      const audioFileChanged = currentAudioBlob !== previousAudioBlob;
      const audioSettingsChanged =
        options?.audioSettings &&
        prevAudioSettingsRef.current &&
        (options.audioSettings.fadeIn !== prevAudioSettingsRef.current.fadeIn ||
          options.audioSettings.fadeOut !== prevAudioSettingsRef.current.fadeOut);

      if (audioSettingsChanged && !audioFileChanged) {
        reason = 'audio-fade';
      } else if (audioFileChanged) {
        reason = 'audio-file';
      }
    }

    // Update refs for next comparison
    if (options?.audioBlob) {
      prevAudioBlobRef.current = options.audioBlob;
    }
    if (options?.audioSettings) {
      prevAudioSettingsRef.current = options.audioSettings;
    }

    await handleFinalizeVideo(undefined, options, true, reason);
  };



  const handleFinalizeVideo = async (
    segmentsOverride?: TransitionVideo[],
    options?: AudioFinalizeOptions,
    skipPreflight: boolean = false,
    updateReason: UpdateReason = 'full'
  ) => {
    const baseSegments = segmentsOverride ?? transitionVideos;

    if (!skipPreflight) {
      const warnings = runPreflightChecks(baseSegments);
      if (warnings.length > 0) {
        setPreflightWarnings(warnings);
        setShowPreflightDialog(true);
        return;
      }
    }

    try {
      setIsFinalizingVideo(true);
      setFinalizationProgress(0);
      setFinalizationMessage('Initializing...');

      const segmentsToFinalize = syncSegmentsToLoopCount(baseSegments, loopCount);

      // Build context for finalization
      const context: FinalizeContext = {
        reason: updateReason,
        cachedBlobs: speedCurveCache ?? undefined,
        previousFinalVideo: finalVideo?.blob,
        audioBlob: options?.audioBlob,
        audioSettings: options?.audioSettings,
      };

      const result = await finalizeVideos(
        segmentsToFinalize,
        context,
        (progress) => {
          setFinalizationProgress(progress.progress);
          setFinalizationMessage(progress.message);
        },
        undefined // Let the hook determine duration from metadata/content
      );

      if (!result) {
        throw new Error('Failed to finalize video');
      }

      // Update cache for future audio-only updates
      setSpeedCurveCache(result.speedCurvedCache);

      // Revoke old object URL to free memory
      if (finalVideo?.url) {
        URL.revokeObjectURL(finalVideo.url);
      }

      // Create new object URL for preview and download
      const objectUrl = URL.createObjectURL(result.finalBlob);

      setFinalVideo({
        blob: result.finalBlob,
        url: objectUrl,
        size: result.finalBlob.size,
        createdAt: new Date(),
      });

      setFinalizationMessage('Video finalized successfully!');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error finalizing video:', error);
      setFinalizationMessage(`Error: ${errorMsg}`);
    } finally {
      setIsFinalizingVideo(false);
    }
  };

  const handleDownloadFinalVideo = () => {
    if (!finalVideo) return;

    const link = document.createElement('a');
    link.href = finalVideo.url;
    link.download = `easy-peasy-ease-${finalVideo.createdAt.getTime()}.mp4`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const reorderTransitionVideos = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
      return;
    }
    setTransitionVideos((prev) => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      return updated;
    });
  };

  // Drag handlers removed (moved to VideoList)

  const handlePlayTransitionVideo = (video: TransitionVideo) => {
    if (!video.url || video.loading) {
      return;
    }
    window.open(video.url, '_blank', 'noopener,noreferrer');
  };

  const warningKeySet = new Set<string>();
  const errorKeySet = new Set<string>();
  const encodeWarnings: string[] = [];
  const encodeErrors: string[] = [];
  let hasPendingEncodeChecks = false;

  transitionVideos.forEach((segment) => {
    const capability = segment.encodeCapability;
    if (!capability) {
      return;
    }
    if (capability.status === 'checking' || capability.status === 'pending') {
      hasPendingEncodeChecks = true;
    }
    const key = `${segment.name}-${segment.width ?? 0}x${segment.height ?? 0}`;
    if (capability.status === 'unsupported') {
      if (!warningKeySet.has(key)) {
        warningKeySet.add(key);
        encodeWarnings.push(`${segment.name} (${formatResolutionLabel(segment.width, segment.height)})`);
      }
    } else if (capability.status === 'error') {
      if (!errorKeySet.has(key)) {
        errorKeySet.add(key);
        encodeErrors.push(segment.name);
      }
    }
  });

  return (
    <div className="relative flex min-h-[calc(100vh-80px)] items-center justify-center bg-background overflow-hidden pb-20 sm:pb-24">
      <LightRays
        className="absolute inset-0 z-0"
        color={isDropZoneHovered ? "rgba(160, 210, 255, 0.17)" : "rgba(160, 210, 255, 0.15)"}
        count={7}
        speed={14}
        length={isDropZoneHovered ? "85vh" : "70vh"}
      />
      <main
        className={cn(
          'relative z-10 flex w-full flex-col items-center justify-center gap-12 px-4 py-12',
          finalVideo ? 'max-w-none items-stretch justify-start px-4 py-8 lg:px-8 lg:py-10' : 'max-w-2xl'
        )}
      >
        {finalVideo ? (
          <section className="w-full min-h-[calc(100vh-5rem)] space-y-8">
            <FinalVideoEditor
              finalVideo={finalVideo}
              segments={transitionVideos}
              selectedSegmentId={selectedSegmentId}
              easingOptions={EASING_PRESETS}
              onSelectSegment={handleSelectSegment}
              onDurationChange={handleSegmentDurationChange}
              onPresetChange={handleSegmentPresetChange}
              onBezierChange={handleSegmentBezierChange}
              defaultBezier={DEFAULT_CUSTOM_BEZIER}
              onCloneSegmentSettings={handleCloneSegmentSettings}
              onUpdateVideo={handleReapplyFinalVideo}
              isUpdating={isFinalizingVideo}
              onExit={() => {
                setFinalVideo(null);
                resetProject();
              }}
              onDownload={handleDownloadFinalVideo}
              loopCount={loopCount}
              onLoopCountChange={handleLoopCountChange}
              onReorder={reorderTransitionVideos}
            />


          </section>
        ) : (
          <>
            {/* Header */}
            <BlurFade>
              <div className="flex flex-col items-center gap-3 text-center">
                <TextPressure
                  text="Stevie-Easy-Peasy"
                  fontFamily="var(--font-inter-variable)"
                  weight={true}
                  width={false}
                  italic={false}
                  alpha={false}
                  flex={false}
                  minFontSize={48}
                  className="text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-foreground max-w-4xl"
                />
                {uploadedVideos.length === 0 && (
                  <div className="flex flex-col items-center gap-2 px-4">
                    <p className="max-w-lg text-base sm:text-lg text-muted-foreground">
                      Free tool to stitch and apply ease curves to short videos.
                    </p>
                    <p className="text-xs text-muted-foreground/50">v0.1.2</p>
                  </div>
                )}
              </div>
            </BlurFade>

            {/* Upload Area - Upload Videos */}
            {uploadedVideos.length === 0 && (
              <BlurFade delay={0.2} className="w-full">
                <div className="w-full space-y-4">
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(event) => {
                      void handleVideosUpload(event);
                    }}
                    className="hidden"
                    id="videos-input"
                    multiple
                    disabled={!isSupported}
                  />
                  <div
                    className={cn(
                      "rounded-lg border-2 border-dashed border-muted-foreground/30 p-12 text-center transition-colors min-h-[300px] flex items-center justify-center",
                      isSupported
                        ? "hover:border-muted-foreground/50 cursor-pointer"
                        : "cursor-not-allowed opacity-75",
                      isDropZoneHovered && "border-primary bg-primary/5"
                    )}
                    onMouseEnter={() => isSupported && setIsDropZoneHovered(true)}
                    onMouseLeave={() => setIsDropZoneHovered(false)}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => isSupported && document.getElementById('videos-input')?.click()}
                    onKeyDown={(e) => {
                      if (isSupported && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        document.getElementById('videos-input')?.click();
                      }
                    }}
                    tabIndex={isSupported ? 0 : -1}
                    role="button"
                    aria-label={isSupported ? "Click to upload videos" : "Browser not supported"}
                    aria-disabled={!isSupported}
                  >
                    <div className="flex flex-col items-center justify-center gap-4">
                      <Upload className="h-10 w-10 text-muted-foreground" />
                      <div className="flex flex-col items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">
                          {!isSupported ? 'Browser not supported, try Chrome' : 'Upload your videos'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {!isSupported ? 'WebCodecs API required' : 'MP4, WebM - Select one or more videos'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </BlurFade>
            )}


            {/* Uploaded Videos Preview */}
            {uploadedVideos.length > 0 && (
              <VideoList
                uploadedVideosCount={uploadedVideos.length}
                transitionVideos={transitionVideos}
                isSupported={isSupported}
                isFinalizing={isFinalizingVideo}
                finalVideo={finalVideo}
                onAddVideos={handleAddMoreVideos}
                onFilesDropped={(files) => void addVideos(files, true)}
                onReset={() => resetProject()}
                onRemoveVideo={removeVideo}
                onPlayVideo={handlePlayTransitionVideo}
                onReorder={reorderTransitionVideos}
                onFinalize={() => void handleFinalizeVideo()}
                encodeWarnings={Array.from(new Set(
                  transitionVideos
                    .filter(v => v.encodeCapability?.status === 'unsupported')
                    .map(v => v.encodeCapability?.message)
                    .filter(Boolean) as string[]
                ))}
                encodeErrors={Array.from(new Set(
                  transitionVideos
                    .filter(v => v.encodeCapability?.status === 'error')
                    .map(v => v.encodeCapability?.message)
                    .filter(Boolean) as string[]
                ))}
                hasPendingEncodeChecks={transitionVideos.some(
                  v => v.encodeCapability?.status === 'checking' || v.encodeCapability?.status === 'pending'
                )}
                finalizationProgress={finalizationProgress}
                finalizationMessage={finalizationMessage}
              />
            )}

          </>
        )}

        <Dialog open={showPreflightDialog} onOpenChange={setShowPreflightDialog}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-500">
                <AlertTriangle className="h-5 w-5" />
                Review Issues
              </DialogTitle>
              <DialogDescription>
                We found some potential issues with your videos.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto py-4 space-y-4">
              {preflightWarnings.map((warning) => (
                <div key={warning.id} className={cn("rounded-md border p-3 text-sm",
                  warning.severity === 'error' ? "bg-destructive/10 border-destructive/20" : "bg-amber-500/10 border-amber-500/20"
                )}>
                  <h5 className={cn("font-semibold mb-1",
                    warning.severity === 'error' ? "text-destructive" : "text-amber-700 dark:text-amber-400"
                  )}>
                    {warning.title}
                  </h5>
                  <p className="text-muted-foreground">{warning.description}</p>
                </div>
              ))}
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setShowPreflightDialog(false)}>
                Back to Edit
              </Button>
              <Button
                variant={preflightWarnings.some(w => w.severity === 'error') ? "destructive" : "default"}
                onClick={() => {
                  setShowPreflightDialog(false);
                  void handleFinalizeVideo(undefined, undefined, true);
                }}
              >
                Proceed Anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={isFinalizingVideo}>
          <DialogContent className="max-w-sm">
            <DialogTitle className="sr-only">Video Processing</DialogTitle>
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="font-semibold text-foreground">
                  {finalizationMessage}
                </p>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Processing...</span>
                  <span>{Math.round(finalizationProgress)}%</span>
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${finalizationProgress}%` }}
                />
              </div>
            </div>
          </DialogContent>
        </Dialog>

      </main>

    </div>
  );
}
