'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Upload, Play, PlayCircle, GripVertical, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { LightRays } from '@/components/ui/light-rays';
import { BlurFade } from '@/components/ui/blur-fade';
import { FinalVideoEditor } from '@/components/FinalVideoEditor';
import { useFinalizeVideo } from '@/hooks/useFinalizeVideo';
import {
  TransitionVideo,
  FinalVideo,
  AudioProcessingOptions,
  SpeedCurvedBlobCache,
  UpdateReason,
  FinalizeContext,
  RenderQuality,
} from '@/lib/types';
import TextPressure from '@/components/text/text-pressure';
import { canEncodeVideo, getEncodableVideoCodecs } from 'mediabunny';
import {
  DEFAULT_CUSTOM_BEZIER,
  EASING_PRESETS,
  getPresetBezier,
} from '@/lib/easing-presets';
import { DEFAULT_EASING } from '@/lib/speed-curve-config';
import { AVC_LEVEL_4_0, AVC_LEVEL_5_1 } from '@/lib/video-encoding';

type AudioFinalizeOptions = {
  audioBlob?: Blob;
  audioSettings?: AudioProcessingOptions;
  updateHint?: UpdateReason;
};

type VideoMetadata = {
  width: number;
  height: number;
  duration: number;
};

const FOUR_K_WIDTH = 3840;
const FOUR_K_HEIGHT = 2160;
const BASELINE_PIXEL_LIMIT = 1920 * 1080; // Use Level 5.1 for resolutions above 1080p
const MAX_TOTAL_SIZE_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5GB

interface PreflightWarning {
  id: string;
  title: string;
  description: string;
  severity: 'warning' | 'error';
}

const readVideoMetadata = (file: File | Blob): Promise<VideoMetadata> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      cleanup();
      if (!width || !height) {
        reject(new Error('Unable to determine video dimensions.'));
        return;
      }
      resolve({ width, height, duration });
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to read video metadata.'));
    };

    video.src = url;
  });

const getCodecStringForResolution = (width: number, height: number) =>
  width * height > BASELINE_PIXEL_LIMIT ? AVC_LEVEL_5_1 : AVC_LEVEL_4_0;

const estimateBitrateForResolution = (width: number, height: number) => {
  const pixels = width * height;
  if (pixels >= FOUR_K_WIDTH * FOUR_K_HEIGHT) {
    return 25_000_000;
  }
  if (pixels >= 2560 * 1440) {
    return 16_000_000;
  }
  if (pixels >= 1920 * 1080) {
    return 12_000_000;
  }
  if (pixels >= 1280 * 720) {
    return 6_000_000;
  }
  return 3_000_000;
};

const formatResolutionLabel = (width?: number, height?: number) =>
  width && height ? `${width}x${height}` : 'this resolution';

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
  const [uploadedVideos, setUploadedVideos] = useState<File[]>([]);
  const [transitionVideos, setTransitionVideos] = useState<TransitionVideo[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null);
  const [loopCount, setLoopCount] = useState(1);
  const [draggingVideoIndex, setDraggingVideoIndex] = useState<number | null>(null);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(null);
  const [finalVideo, setFinalVideo] = useState<FinalVideo | null>(null);
  const [isFinalizingVideo, setIsFinalizingVideo] = useState(false);
  const [finalizationProgress, setFinalizationProgress] = useState(0);
  const [finalizationMessage, setFinalizationMessage] = useState('');
  const [isDropZoneHovered, setIsDropZoneHovered] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [preflightWarnings, setPreflightWarnings] = useState<PreflightWarning[]>([]);
  const [showPreflightDialog, setShowPreflightDialog] = useState(false);
  const [renderQuality, setRenderQuality] = useState<RenderQuality>('preview');
  const [currentRenderQuality, setCurrentRenderQuality] = useState<RenderQuality | null>(null);
  const transitionVideosRef = useRef<TransitionVideo[]>([]);

  // Cache for speed-curved blobs to enable fast audio-only updates
  const [speedCurveCache, setSpeedCurveCache] = useState<SpeedCurvedBlobCache | null>(null);

  // Refs for tracking previous values to detect what changed
  const prevAudioBlobRef = useRef<Blob | null>(null);
  const prevAudioSettingsRef = useRef<AudioProcessingOptions | null>(null);

  useEffect(() => {
    const checkSupport = async () => {
      try {
        // Check if the browser supports any video encoding
        // This implicitly checks for WebCodecs support
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

  const cleanupSegmentResources = useCallback((segments: TransitionVideo[]) => {
    segments.forEach((segment) => {
      if (segment.url) {
        try {
          URL.revokeObjectURL(segment.url);
        } catch {
          // Ignore double-revoke errors
        }
      }
    });
  }, []);

  useEffect(() => {
    transitionVideosRef.current = transitionVideos;
  }, [transitionVideos]);

  useEffect(() => {
    return () => {
      cleanupSegmentResources(transitionVideosRef.current);
    };
  }, [cleanupSegmentResources]);

  const evaluateVideoEncodeCapability = useCallback(
    async (segments: TransitionVideo[]) => {
      await Promise.all(
        segments.map(async (segment) => {
          const blobSource = segment.cachedBlob ?? segment.file;
          if (!blobSource) {
            return;
          }
          const segmentId = segment.id;

          setTransitionVideos((prev) => {
            if (!prev.some((v) => v.id === segmentId)) {
              return prev;
            }
            return prev.map((v) =>
              v.id === segmentId
                ? {
                  ...v,
                  encodeCapability: {
                    status: 'checking',
                    message: 'Checking device encoder support…',
                  },
                }
                : v
            );
          });

          try {
            const metadata = await readVideoMetadata(blobSource);
            const codecString = getCodecStringForResolution(metadata.width, metadata.height);
            const bitrate = estimateBitrateForResolution(metadata.width, metadata.height);
            const supported = await canEncodeVideo('avc', {
              width: metadata.width,
              height: metadata.height,
              bitrate,
              fullCodecString: codecString,
            });

            setTransitionVideos((prev) => {
              if (!prev.some((v) => v.id === segmentId)) {
                return prev;
              }
              return prev.map((v) =>
                v.id === segmentId
                  ? {
                    ...v,
                    width: metadata.width,
                    height: metadata.height,
                    encodeCapability: {
                      status: supported ? 'supported' : 'unsupported',
                      message: supported
                        ? `Device can encode ${metadata.width}x${metadata.height} AVC`
                        : `Device encoder cannot output ${metadata.width}x${metadata.height}`,
                      codecString,
                      bitrate,
                    },
                  }
                  : v
              );
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unable to verify encode capability';
            setTransitionVideos((prev) => {
              if (!prev.some((v) => v.id === segmentId)) {
                return prev;
              }
              return prev.map((v) =>
                v.id === segmentId
                  ? {
                    ...v,
                    encodeCapability: {
                      status: 'error',
                      message: errorMessage,
                    },
                  }
                  : v
              );
            });
          }
        })
      );
    },
    [setTransitionVideos]
  );

  const handleVideosUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!(files && files[0])) {
        return;
      }

      const videoFiles = Array.from(files).filter((f) => f.type.startsWith('video/'));
      setUploadedVideos(videoFiles);

      try {
        const preparedSegments = await Promise.all(
          videoFiles.map(async (file, index) => {
            const buffer = await file.arrayBuffer();
            const cachedBlob = new Blob([buffer], { type: file.type || 'video/mp4' });
            const objectUrl = URL.createObjectURL(cachedBlob);

            return {
              id: index + 1,
              name: file.name,
              url: objectUrl,
              loading: false,
              duration: 1.5,
              easingPreset: DEFAULT_EASING,
              useCustomEasing: false,
              customBezier: getPresetBezier(DEFAULT_EASING),
              loopIteration: 1,
              file,
              cachedBlob,
              encodeCapability: {
                status: 'checking',
                message: 'Checking device encoder support...',
              },
            } as TransitionVideo;
          })
        );

        setTransitionVideos((prev) => {
          cleanupSegmentResources(prev);
          return preparedSegments;
        });
        setLoopCount(1);
        setSelectedSegmentId(preparedSegments[0]?.id ?? null);
        // Clear cache when new videos are uploaded
        setSpeedCurveCache(null);
        prevAudioBlobRef.current = null;
        prevAudioSettingsRef.current = null;
        void evaluateVideoEncodeCapability(preparedSegments);
      } catch (error) {
        console.error('Failed to process uploaded videos', error);
      } finally {
        if (e.target) {
          e.target.value = '';
        }
      }
    },
    [cleanupSegmentResources, evaluateVideoEncodeCapability]
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

  const updateSegmentMetadata = (
    id: number,
    updates: Partial<TransitionVideo>,
    applyAll: boolean = false
  ) => {
    setTransitionVideos((prev) =>
      prev.map((segment) => {
        const shouldUpdate = applyAll || segment.id === id;
        if (!shouldUpdate) {
          return segment;
        }

        const nextUpdates = { ...updates };
        if (updates.customBezier) {
          nextUpdates.customBezier = [...updates.customBezier] as [
            number,
            number,
            number,
            number
          ];
        }

        return { ...segment, ...nextUpdates };
      })
    );
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
  }, [finalVideo, transitionVideos, selectedSegmentId]);

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

  const handleReapplyFinalVideo = async (options?: AudioFinalizeOptions & { quality?: RenderQuality }) => {
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

    await handleFinalizeVideo(undefined, options, true, options?.quality, reason);
  };

  const runPreflightChecks = (segments: TransitionVideo[]): PreflightWarning[] => {
    const warnings: PreflightWarning[] = [];

    // 1. Check for mixed orientation
    let hasPortrait = false;
    let hasLandscape = false;
    segments.forEach((s) => {
      if (s.width && s.height) {
        if (s.height > s.width) hasPortrait = true;
        else hasLandscape = true;
      }
    });

    if (hasPortrait && hasLandscape) {
      warnings.push({
        id: 'orientation-mismatch',
        title: 'Mixed Video Orientations',
        description: 'You have both portrait and landscape videos. The final output might look rotated or stretched.',
        severity: 'warning',
      });
    }

    // 2. Check for large resolution disparity
    let minHeight = Infinity;
    let maxHeight = 0;
    segments.forEach((s) => {
      if (s.height) {
        minHeight = Math.min(minHeight, s.height);
        maxHeight = Math.max(maxHeight, s.height);
      }
    });

    if (maxHeight > 0 && minHeight < Infinity && maxHeight > minHeight * 2) {
      warnings.push({
        id: 'resolution-disparity',
        title: 'Resolution Disparity',
        description: `Some videos are much larger than others (Max: ${maxHeight}p, Min: ${minHeight}p). Smaller videos will be upscaled, which may look blurry.`,
        severity: 'warning',
      });
    }

    // 3. Check total file size
    const totalSize = segments.reduce((acc, s) => acc + (s.file?.size || 0), 0);
    if (totalSize > MAX_TOTAL_SIZE_BYTES) {
      warnings.push({
        id: 'large-files',
        title: 'Large Project Size',
        description: `Total video size is ${(totalSize / (1024 * 1024 * 1024)).toFixed(1)}GB. This might crash the browser during processing.`,
        severity: 'error', // High risk
      });
    }

    // 4. Encoder support (re-using existing status)
    const unsupportedVideos = segments.filter(s => s.encodeCapability?.status === 'unsupported');
    if (unsupportedVideos.length > 0) {
      warnings.push({
        id: 'unsupported-encoder',
        title: 'Unsupported Resolution',
        description: `Your device cannot encode some video resolutions (e.g. ${unsupportedVideos[0].width}x${unsupportedVideos[0].height}). The process will likely fail.`,
        severity: 'error',
      });
    }

    return warnings;
  };

  const handleFinalizeVideo = async (
    segmentsOverride?: TransitionVideo[],
    options?: AudioFinalizeOptions,
    skipPreflight: boolean = false,
    qualityOverride?: RenderQuality,
    updateReason: UpdateReason = 'full'
  ) => {
    const baseSegments = segmentsOverride ?? transitionVideos;
    const effectiveQuality = qualityOverride ?? renderQuality;

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
      setFinalizationMessage(effectiveQuality === 'preview' ? 'Initializing preview render...' : 'Initializing...');

      const segmentsToFinalize = syncSegmentsToLoopCount(baseSegments, loopCount);

      // Build context for finalization
      const context: FinalizeContext = {
        reason: updateReason,
        cachedBlobs: speedCurveCache ?? undefined,
        previousFinalVideo: finalVideo?.blob,
        audioBlob: options?.audioBlob,
        audioSettings: options?.audioSettings,
        quality: effectiveQuality,
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
      setCurrentRenderQuality(effectiveQuality);

      setFinalizationMessage(effectiveQuality === 'preview' ? 'Preview ready!' : 'Video finalized successfully!');
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

  const handleVideoDragStart = (index: number) => (event: React.DragEvent<HTMLButtonElement>) => {
    setDraggingVideoIndex(index);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', index.toString());
  };

  const handleVideoDragOver = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (draggingVideoIndex === null || draggingVideoIndex === index) {
      setDropIndicatorIndex(null);
      return;
    }
    event.dataTransfer.dropEffect = 'move';
    setDropIndicatorIndex(index);
  };

  const handleVideoDrop = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sourceIndex =
      draggingVideoIndex ?? Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(sourceIndex)) {
      setDraggingVideoIndex(null);
      setDropIndicatorIndex(null);
      return;
    }
    reorderTransitionVideos(sourceIndex, index);
    setDraggingVideoIndex(null);
    setDropIndicatorIndex(null);
  };

  const handleVideoDragEnd = () => {
    setDraggingVideoIndex(null);
    setDropIndicatorIndex(null);
  };

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
                setTransitionVideos((prev) => {
                  cleanupSegmentResources(prev);
                  return [];
                });
                setUploadedVideos([]);
                setSelectedSegmentId(null);
                setLoopCount(1);
                setCurrentRenderQuality(null);
                // Clear cache when exiting
                setSpeedCurveCache(null);
                prevAudioBlobRef.current = null;
                prevAudioSettingsRef.current = null;
              }}
              onDownload={handleDownloadFinalVideo}
              loopCount={loopCount}
              onLoopCountChange={handleLoopCountChange}
              renderQuality={renderQuality}
              onRenderQualityChange={setRenderQuality}
              currentRenderQuality={currentRenderQuality}
            />

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
          </section>
        ) : (
          <>
            {/* Header */}
            <BlurFade>
              <div className="flex flex-col items-center gap-3 text-center">
                <TextPressure
                  text="EasyPeasyEase"
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
                        : "cursor-not-allowed opacity-75"
                    )}
                    onMouseEnter={() => isSupported && setIsDropZoneHovered(true)}
                    onMouseLeave={() => setIsDropZoneHovered(false)}
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
              <BlurFade delay={0.2} className="w-full">
                <div className="w-full space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">
                      Uploaded Videos ({uploadedVideos.length})
                    </h3>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setUploadedVideos([]);
                        setTransitionVideos((prev) => {
                          cleanupSegmentResources(prev);
                          return [];
                        });
                        setFinalVideo(null);
                        setSelectedSegmentId(null);
                        // Clear cache when resetting
                        setSpeedCurveCache(null);
                        prevAudioBlobRef.current = null;
                        prevAudioSettingsRef.current = null;
                      }}
                    >
                      Reset
                    </Button>
                  </div>

                  {/* Videos List with Reordering */}
                  <div className="space-y-3">
                    {transitionVideos.map((video, index) => {
                      const isDragging = draggingVideoIndex === index;
                      const statusText = video.loading
                        ? 'Generating...'
                        : video.error
                          ? `Error: ${video.error}`
                          : video.url
                            ? 'Ready to finalize'
                            : 'Pending';
                      const statusColor = video.error
                        ? 'text-destructive'
                        : video.loading
                          ? 'text-muted-foreground'
                          : 'text-emerald-500';
                      const encodeCapability = video.encodeCapability;
                      let encodeStatusText: string | null = null;
                      let encodeStatusClass = 'text-muted-foreground';

                      if (encodeCapability) {
                        switch (encodeCapability.status) {
                          case 'pending':
                          case 'checking':
                            encodeStatusText =
                              encodeCapability.message ?? 'Checking device encoder support…';
                            encodeStatusClass = 'text-muted-foreground';
                            break;
                          case 'supported':
                            encodeStatusText = null;
                            break;
                          case 'unsupported':
                            encodeStatusText =
                              encodeCapability.message ??
                              `Cannot encode ${formatResolutionLabel(video.width, video.height)} on this device`;
                            encodeStatusClass = 'text-amber-600';
                            break;
                          case 'error':
                            encodeStatusText =
                              encodeCapability.message ?? 'Encoder support check failed';
                            encodeStatusClass = 'text-amber-600';
                            break;
                          default:
                            encodeStatusText = encodeCapability.message ?? null;
                            encodeStatusClass = 'text-muted-foreground';
                        }
                      }

                      return (
                        <div key={video.id}>
                          <div
                            className={cn(
                              'flex items-center gap-3 rounded-lg border border-border/80 bg-secondary/50 p-4 transition-colors',
                              isDragging && 'ring-2 ring-primary/40 bg-secondary'
                            )}
                            onDragOver={handleVideoDragOver(index)}
                            onDrop={handleVideoDrop(index)}
                          >


                            <button
                              type="button"
                              className="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-border/70 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary cursor-grab"
                              draggable
                              onDragStart={handleVideoDragStart(index)}
                              onDragEnd={handleVideoDragEnd}
                              aria-label={`Reorder ${video.name}`}
                            >
                              <GripVertical className="h-4 w-4" />
                            </button>

                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-primary hover:bg-primary/10 disabled:text-muted-foreground"
                              onClick={() => handlePlayTransitionVideo(video)}
                              disabled={!video.url || video.loading}
                            >
                              <PlayCircle className="h-5 w-5" />
                            </Button>

                            <div className="flex-1 min-w-0 flex items-center gap-3">
                              {video.url && (
                                <video
                                  src={video.url}
                                  className="h-12 w-16 rounded-md object-cover flex-shrink-0 bg-secondary"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">
                                  {index + 1}. {video.name}
                                </p>
                                <p className={cn('text-xs mt-1', statusColor)}>{statusText}</p>
                                {encodeStatusText && (
                                  <p className={cn('text-xs mt-0.5', encodeStatusClass)}>
                                    {encodeStatusText}
                                  </p>
                                )}
                              </div>
                            </div>

                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-foreground hover:bg-secondary/80"
                              onClick={() => {
                                setTransitionVideos((prev) => {
                                  const target = prev.find((v) => v.id === video.id);
                                  if (target) {
                                    cleanupSegmentResources([target]);
                                  }
                                  return prev.filter((v) => v.id !== video.id);
                                });
                                setUploadedVideos((prev) => prev.filter((f) => f.name !== video.name));
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          {dropIndicatorIndex === index && (
                            <div className="h-0.5 bg-primary mt-2 mb-1" />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Finalize Button for Uploaded Videos */}
                  {transitionVideos.every((v) => v.url && !v.loading) && !isFinalizingVideo && (
                    <div className="space-y-3">
                      <div className="flex flex-col items-center gap-3">
                        <label className="flex items-center gap-2 text-sm text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={renderQuality === 'preview'}
                            onChange={(e) => setRenderQuality(e.target.checked ? 'preview' : 'full')}
                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                          Render previews in lower quality (faster)
                        </label>
                        <Button
                          size="lg"
                          onClick={() => handleFinalizeVideo()}
                          className="gap-2"
                        >
                          <Play className="h-4 w-4" />
                          {finalVideo ? 'Finalize Again' : 'Finalize & Stitch Videos'}
                        </Button>
                      </div>
                      {hasPendingEncodeChecks && encodeWarnings.length === 0 && (
                        <p className="text-center text-xs text-muted-foreground">
                          Checking device encoder support for uploaded videos…
                        </p>
                      )}
                      {encodeWarnings.length > 0 && (
                        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
                          <p className="font-semibold">This device can&apos;t encode:</p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            {encodeWarnings.map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                          <p className="mt-3 text-xs">
                            Consider downscaling or trimming before finalizing to avoid encoder errors on this device.
                          </p>
                        </div>
                      )}
                      {encodeErrors.length > 0 && (
                        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-800 dark:text-yellow-200">
                          Unable to verify encoder support for {encodeErrors.join(', ')}. Finalization may still work,
                          but it could fail if the device encoder is limited.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Finalization Progress */}
                  {isFinalizingVideo && (
                    <div className="w-full space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-foreground">
                          {finalizationMessage}
                        </p>
                        <span className="text-sm text-muted-foreground">
                          {Math.round(finalizationProgress)}%
                        </span>
                      </div>
                      <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-primary h-full transition-all duration-300"
                          style={{ width: `${finalizationProgress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </BlurFade>
            )}

          </>
        )}
      </main>

    </div>
  );
}
