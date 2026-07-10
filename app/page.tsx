'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Upload, Play, PlayCircle, GripVertical, Trash2, AlertTriangle, Scissors, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { LightRays } from '@/components/ui/light-rays';
import { BlurFade } from '@/components/ui/blur-fade';
import { FinalVideoEditor } from '@/components/FinalVideoEditor';
import { VideoSplitEditor, type SplitConfig } from '@/components/VideoSplitEditor';
import { buildSectionSegments } from '@/lib/chunking';
import { useFinalizeVideo } from '@/hooks/useFinalizeVideo';
import {
  TransitionVideo,
  FinalVideo,
  AudioProcessingOptions,
  SpeedCurvedBlobCache,
  UpdateReason,
  FinalizeContext,
  RenderQuality,
  VideoEncodeCapability,
} from '@/lib/types';
import TextPressure from '@/components/text/text-pressure';
import {
  getEncodableVideoCodecs,
  canEncodeAudio,
  Input,
  BlobSource,
  ALL_FORMATS,
} from 'mediabunny';
import {
  DEFAULT_CUSTOM_BEZIER,
  EASING_PRESETS,
  getPresetBezier,
} from '@/lib/easing-presets';
import { DEFAULT_EASING, MAX_OUTPUT_FPS, PREVIEW_FPS } from '@/lib/speed-curve-config';
import { buildEncodeTiers } from '@/lib/encode-planner';
import { selectSupportedTier } from '@/lib/video-encoding';
import { ensureAudioEncoders } from '@/lib/audio-codec';

type AudioFinalizeOptions = {
  audioBlob?: Blob;
  audioSettings?: AudioProcessingOptions;
  updateHint?: UpdateReason;
  /** Re-render with these segments instead of current state — used when the
   *  caller has just mutated segment state (e.g. clone-to-all) and can't wait
   *  for the async state update to land. */
  segments?: TransitionVideo[];
};

type VideoMetadata = {
  width: number;
  height: number;
  duration: number;
};

type EditorMode = 'stitch' | 'split';

/** One long video staged for the "Split a video" flow. */
type SplitSource = {
  file: File;
  url: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  encodeCapability?: VideoEncodeCapability;
};

const MAX_TOTAL_SIZE_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5GB

interface PreflightWarning {
  id: string;
  title: string;
  description: string;
  severity: 'warning' | 'error';
}

/**
 * Probe an uploaded video with mediabunny (works for anything the render
 * pipeline can read, unlike an HTMLVideoElement) and report whether this
 * machine can decode it and encode output for it.
 */
const readVideoMetadata = async (
  file: File | Blob
): Promise<VideoMetadata & { codedWidth: number; codedHeight: number; canDecode: boolean; bitrate?: number }> => {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      throw new Error('No video track found in this file.');
    }
    const [displayWidth, displayHeight, codedWidth, codedHeight, canDecode, firstTimestamp, endTimestamp, stats] =
      await Promise.all([
        track.getDisplayWidth(),
        track.getDisplayHeight(),
        track.getCodedWidth(),
        track.getCodedHeight(),
        track.canDecode().catch(() => false),
        track.getFirstTimestamp().catch(() => 0),
        track.computeDuration().catch(() => 0),
        track.computePacketStats().catch(() => null),
      ]);
    // mediabunny's computeDuration() returns the END timestamp of the last
    // packet, and getFirstTimestamp() can be non-zero (Android/edited clips).
    // The playable content span is end - first — this is what split points are
    // measured against (they're offsets from the first frame in the retimer).
    const duration = Math.max(0, endTimestamp - firstTimestamp);
    return {
      width: displayWidth,
      height: displayHeight,
      codedWidth,
      codedHeight,
      canDecode,
      duration,
      bitrate:
        stats?.averageBitrate && Number.isFinite(stats.averageBitrate)
          ? stats.averageBitrate
          : undefined,
    };
  } finally {
    input.dispose();
  }
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
  const [mode, setMode] = useState<EditorMode>('stitch');
  const [splitSource, setSplitSource] = useState<SplitSource | null>(null);
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
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [finalizeWarnings, setFinalizeWarnings] = useState<string[]>([]);
  const [audioExportSupported, setAudioExportSupported] = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const transitionVideosRef = useRef<TransitionVideo[]>([]);
  const finalizeAbortRef = useRef<AbortController | null>(null);

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
          return;
        }
        // Audio preflight: registers the AAC WASM polyfill when the browser
        // lacks a native encoder (e.g. Firefox), then verifies music export
        // will actually work so users learn about it before rendering.
        await ensureAudioEncoders();
        const audioOk = (await canEncodeAudio('aac')) || (await canEncodeAudio('mp3'));
        setAudioExportSupported(audioOk);
      } catch (e) {
        console.warn("WebCodecs support check failed:", e);
        setIsSupported(false);
      }
    };
    checkSupport();
  }, []);

  // A file dropped outside the upload zone must not navigate the tab away
  // (which destroys the whole session).
  useEffect(() => {
    const prevent = (event: DragEvent) => {
      event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // Long renders: keep the screen awake (feature-detected) and warn before
  // the tab is closed accidentally.
  useEffect(() => {
    if (!isFinalizingVideo) {
      return;
    }

    let wakeLock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request('screen')
      .then((lock) => {
        if (cancelled) {
          void lock.release().catch(() => {});
        } else {
          wakeLock = lock;
        }
      })
      .catch(() => {});

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);

    return () => {
      cancelled = true;
      window.removeEventListener('beforeunload', beforeUnload);
      void wakeLock?.release().catch(() => {});
    };
  }, [isFinalizingVideo]);

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

            // Plan output tiers exactly the way the render pipeline will,
            // and check the full ladder: a device that cannot handle native
            // resolution but can handle 1080p is still supported (it will
            // render at the best tier it can).
            const tiers = buildEncodeTiers(
              { width: metadata.codedWidth, height: metadata.codedHeight, bitrate: metadata.bitrate },
              'full',
              [MAX_OUTPUT_FPS, PREVIEW_FPS]
            );
            const tier = metadata.canDecode ? await selectSupportedTier(tiers) : null;

            const supported = metadata.canDecode && tier !== null;
            const isNativeTier =
              tier !== null && !tier.needsResize;
            const message = !metadata.canDecode
              ? 'This browser cannot decode this video format. Try converting it to H.264 MP4.'
              : tier === null
                ? `Device encoder cannot output ${formatResolutionLabel(metadata.width, metadata.height)}`
                : isNativeTier
                  ? `Device can encode ${formatResolutionLabel(metadata.width, metadata.height)}`
                  : `Will render at ${tier.width}x${tier.height} on this device (source is ${formatResolutionLabel(metadata.width, metadata.height)})`;

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
                      message,
                      codecString: tier?.codecString,
                      bitrate: tier?.bitrate,
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

  const processVideosUpload = useCallback(
    async (files: File[]) => {
      const videoFiles = files.filter((file) => file.type.startsWith('video/'));
      if (videoFiles.length === 0) {
        setUploadError('Drop one or more MP4 or WebM video files.');
        return;
      }

      setUploadError(null);
      setUploadedVideos(videoFiles);

      try {
        // Keep the File reference as the source of truth: Files are backed
        // by disk and mediabunny reads them lazily in ranges, so uploads no
        // longer get copied wholesale into RAM (which crashed low-memory
        // devices). The finalize path verifies readability and falls back to
        // fetching the object URL if the file becomes unreadable.
        const preparedSegments = videoFiles.map((file, index) => {
          const objectUrl = URL.createObjectURL(file);

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
            encodeCapability: {
              status: 'checking',
              message: 'Checking device encoder support...',
            },
          } as TransitionVideo;
        });

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
        setUploadError('Failed to prepare the dropped videos.');
      }
    },
    [cleanupSegmentResources, evaluateVideoEncodeCapability]
  );

  const handleVideosUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = '';
      await processVideosUpload(files);
    },
    [processVideosUpload]
  );

  const processSplitVideoUpload = useCallback(
    async (file?: File) => {
      if (!file || !file.type.startsWith('video/')) {
        setUploadError('Drop a single MP4 or WebM video file.');
        return;
      }

      setUploadError(null);
      const url = URL.createObjectURL(file);
      try {
        const metadata = await readVideoMetadata(file);
        if (!(metadata.duration > 0) || !Number.isFinite(metadata.duration)) {
          throw new Error('Could not read this video’s duration. Try a different file.');
        }

        // Probe encode capability with the exact plan the render will use, so
        // the split editor can warn before the user spends time placing splits.
        let capability: VideoEncodeCapability;
        try {
          const tiers = buildEncodeTiers(
            { width: metadata.codedWidth, height: metadata.codedHeight, bitrate: metadata.bitrate },
            'full',
            [MAX_OUTPUT_FPS, PREVIEW_FPS]
          );
          const tier = metadata.canDecode ? await selectSupportedTier(tiers) : null;
          const supported = metadata.canDecode && tier !== null;
          const isNativeTier = tier !== null && !tier.needsResize;
          capability = {
            status: supported ? 'supported' : 'unsupported',
            message: !metadata.canDecode
              ? 'This browser cannot decode this video format. Try converting it to H.264 MP4.'
              : tier === null
                ? `Device encoder cannot output ${formatResolutionLabel(metadata.width, metadata.height)}`
                : isNativeTier
                  ? `Device can encode ${formatResolutionLabel(metadata.width, metadata.height)}`
                  : `Will render at ${tier.width}x${tier.height} on this device (source is ${formatResolutionLabel(metadata.width, metadata.height)})`,
            codecString: tier?.codecString,
            bitrate: tier?.bitrate,
          };
        } catch (capErr) {
          capability = {
            status: 'error',
            message: capErr instanceof Error ? capErr.message : 'Unable to verify encode capability',
          };
        }

        setUploadedVideos([file]);
        setSplitSource({
          file,
          url,
          name: file.name,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          encodeCapability: capability,
        });
      } catch (error) {
        URL.revokeObjectURL(url);
        console.error('Failed to read uploaded video', error);
        setUploadError(error instanceof Error ? error.message : 'Failed to read this video.');
      }
    },
    []
  );

  const handleSplitVideoUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      await processSplitVideoUpload(file);
    },
    [processSplitVideoUpload]
  );

  const handleDropZoneDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDropZoneHovered(false);

      if (!isSupported) return;

      const files = Array.from(event.dataTransfer.files);
      if (mode === 'split') {
        const videoFiles = files.filter((file) => file.type.startsWith('video/'));
        if (videoFiles.length !== 1) {
          setUploadError('Split mode accepts exactly one video file.');
          return;
        }
        void processSplitVideoUpload(videoFiles[0]);
        return;
      }

      void processVideosUpload(files);
    },
    [isSupported, mode, processSplitVideoUpload, processVideosUpload]
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

  const handleCloneSegmentSettings = (id: number): TransitionVideo[] | undefined => {
    const sourceSegment = transitionVideos.find((segment) => segment.id === id);
    if (!sourceSegment) {
      return undefined;
    }

    const sourceCurve =
      sourceSegment.customBezier ??
      getPresetBezier(sourceSegment.easingPreset ?? DEFAULT_EASING);

    const next = transitionVideos.map((segment) => {
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
    });
    setTransitionVideos(next);
    // Returned so a same-tick re-render can use the cloned settings without
    // waiting for the state update to flush.
    return next;
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

    await handleFinalizeVideo(options?.segments, options, true, options?.quality, reason);
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

    // 3. Check total file size. Split-mode sections all reference the same
    // source file, so count each distinct file only once (otherwise an N-way
    // split would report N× the real size).
    const seenFiles = new Set<File | Blob>();
    let totalSize = 0;
    segments.forEach((s) => {
      if (s.file && !seenFiles.has(s.file)) {
        seenFiles.add(s.file);
        totalSize += s.file.size;
      }
    });
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

    const abortController = new AbortController();
    finalizeAbortRef.current = abortController;

    try {
      setIsFinalizingVideo(true);
      setFinalizationProgress(0);
      setFinalizeError(null);
      setFinalizeWarnings([]);
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
        signal: abortController.signal,
      };

      let latestWarnings: string[] = [];
      let pipelineError: string | null = null;
      const result = await finalizeVideos(
        segmentsToFinalize,
        context,
        (progress) => {
          setFinalizationProgress(progress.progress);
          setFinalizationMessage(progress.message);
          if (progress.warnings) {
            latestWarnings = progress.warnings;
          }
          if (progress.stage === 'error' && progress.error) {
            pipelineError = progress.error;
          }
        },
        undefined // Let the hook determine duration from metadata/content
      );
      setFinalizeWarnings(latestWarnings);

      if (!result) {
        if (abortController.signal.aborted) {
          setFinalizationMessage('Render cancelled');
          return;
        }
        throw new Error(pipelineError ?? 'Failed to finalize video');
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
      // Surface the failure in a dialog that outlives the progress modal —
      // errors used to vanish with it, leaving users with no explanation.
      setFinalizeError(errorMsg);
    } finally {
      finalizeAbortRef.current = null;
      setIsFinalizingVideo(false);
    }
  };

  // "Split a video": turn the placed splits into per-section segments (all
  // sharing the one source file) and render them through the same pipeline the
  // multi-clip flow uses. Defined after handleFinalizeVideo so it can call it.
  const handleCreateSections = async (config: SplitConfig) => {
    if (!splitSource || config.sections.length === 0) {
      return;
    }

    const segments = buildSectionSegments(
      {
        file: splitSource.file,
        name: splitSource.name,
        width: splitSource.width,
        height: splitSource.height,
        encodeCapability: splitSource.encodeCapability,
      },
      config.sections,
      { outputDuration: config.outputDuration, easingPreset: config.easingPreset },
      (f) => URL.createObjectURL(f)
    );

    setTransitionVideos((prev) => {
      cleanupSegmentResources(prev);
      return segments;
    });
    setLoopCount(1);
    setSelectedSegmentId(segments[0]?.id ?? null);
    setSpeedCurveCache(null);
    prevAudioBlobRef.current = null;
    prevAudioSettingsRef.current = null;

    // updateReason 'full' — this is a fresh render of brand-new segments.
    // Quality follows the renderQuality toggle (preview-first, like stitch).
    await handleFinalizeVideo(segments, undefined, false, undefined, 'full');
  };

  const handleExitSplit = () => {
    setSplitSource((prev) => {
      if (prev) {
        URL.revokeObjectURL(prev.url);
      }
      return null;
    });
    // A failed create can leave staged section segments (with object URLs) in
    // state; revoke them so backing out doesn't leak.
    setTransitionVideos((prev) => {
      cleanupSegmentResources(prev);
      return [];
    });
    setSelectedSegmentId(null);
    setSpeedCurveCache(null);
    setUploadedVideos([]);
    setUploadError(null);
    prevAudioBlobRef.current = null;
    prevAudioSettingsRef.current = null;
  };

  // Once a final video exists the split source has served its purpose; revoke
  // its preview URL and drop it so the FinalVideoEditor takes over cleanly.
  useEffect(() => {
    if (finalVideo && splitSource) {
      URL.revokeObjectURL(splitSource.url);
      setSplitSource(null);
    }
  }, [finalVideo, splitSource]);

  const handleCancelFinalize = () => {
    finalizeAbortRef.current?.abort();
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

  // Shared across the final-video and split editors (mutually exclusive
  // branches, so only one instance is ever mounted at a time).
  const preflightDialog = (
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
  );

  const finalizingDialog = (
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
              <span className="tabular-nums">{Math.round(finalizationProgress)}%</span>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${finalizationProgress}%` }}
            />
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={handleCancelFinalize}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="flex flex-1 flex-col">
    <div
      className={cn(
        'relative flex flex-1 items-center justify-center bg-background overflow-hidden',
        // The big bottom pad balances the centred landing hero; in the
        // editors it would just push the footer away from the controls.
        !(finalVideo || splitSource) && 'pb-20 sm:pb-24'
      )}
    >
      <LightRays
        className="absolute inset-0 z-0"
        color="rgba(160, 210, 255, 0.15)"
        count={7}
        speed={14}
        length="70vh"
        interactive={isDropZoneHovered}
      />
      <main
        className={cn(
          'relative z-10 flex w-full flex-col items-center justify-center gap-12 px-4 py-12',
          finalVideo || splitSource
            ? 'max-w-none items-stretch justify-start self-stretch p-2'
            : 'max-w-2xl'
        )}
      >
        {finalVideo ? (
          <section className="w-full space-y-8">
            {finalizeWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
                {finalizeWarnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}
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
                if (finalVideo?.url) {
                  URL.revokeObjectURL(finalVideo.url);
                }
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

            {preflightDialog}
            {finalizingDialog}
          </section>
        ) : splitSource ? (
          <section className="w-full space-y-8">
            <VideoSplitEditor
              file={splitSource.file}
              url={splitSource.url}
              duration={splitSource.duration}
              width={splitSource.width}
              height={splitSource.height}
              encodeCapability={splitSource.encodeCapability}
              easingOptions={EASING_PRESETS}
              onCreate={(config: SplitConfig) => {
                void handleCreateSections(config);
              }}
              onBack={handleExitSplit}
              isBusy={isFinalizingVideo}
            />

            {preflightDialog}
            {finalizingDialog}
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
                  initialAnimationDelay={450}
                  className="text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-foreground max-w-4xl"
                />
                <AnimatePresence initial={false}>
                {uploadedVideos.length === 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -4, filter: 'blur(2px)' }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    className="flex flex-col items-center gap-2 px-4"
                  >
                    <p className="max-w-lg text-base sm:text-lg text-pretty text-muted-foreground">
                      Free tool to stitch and apply ease curves to short videos.
                    </p>
                    <p className="text-xs text-muted-foreground/50">v0.1.3</p>
                  </motion.div>
                )}
                </AnimatePresence>
              </div>
            </BlurFade>

            {/* Upload Area */}
            <AnimatePresence initial={false} mode="wait">
            {uploadedVideos.length === 0 && (
              <BlurFade key="upload" delay={0.12} className="w-full">
                <div className="w-full space-y-4">
                  {/* Mode toggle: stitch many clips vs split one long video.
                      Toggle buttons (aria-pressed), not a tablist — there is no
                      tabpanel and no roving-tabindex arrow-key contract here. */}
                  <div className="flex justify-center">
                    <div
                      role="group"
                      aria-label="Choose how to start"
                      className="landing-surface relative isolate inline-grid grid-cols-2 rounded-xl border border-border/70 bg-secondary/40 p-1"
                    >
                      <motion.span
                        aria-hidden="true"
                        initial={false}
                        animate={{ x: mode === 'stitch' ? '0%' : '100%' }}
                        transition={{ type: 'tween', duration: 0.24, ease: 'easeOut' }}
                        className="pointer-events-none absolute inset-y-1 left-1 z-0 w-[calc(50%_-_0.25rem)] rounded-lg bg-primary shadow-sm"
                      />
                      <button
                        type="button"
                        aria-pressed={mode === 'stitch'}
                        onClick={() => {
                          setMode('stitch');
                          setUploadError(null);
                        }}
                        className={cn(
                          'relative z-10 inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-[color,scale] duration-200 ease-out active:scale-[0.96]',
                          mode === 'stitch'
                            ? 'text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <Layers className="h-4 w-4" />
                        <span>Stitch clips</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={mode === 'split'}
                        onClick={() => {
                          setMode('split');
                          setUploadError(null);
                        }}
                        className={cn(
                          'relative z-10 inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-[color,scale] duration-200 ease-out active:scale-[0.96]',
                          mode === 'split'
                            ? 'text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <Scissors className="h-4 w-4" />
                        <span>Split one video</span>
                      </button>
                    </div>
                  </div>

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
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(event) => {
                      void handleSplitVideoUpload(event);
                    }}
                    className="hidden"
                    id="split-input"
                    disabled={!isSupported}
                  />
                  <div
                    className={cn(
                      "landing-drop-zone group min-h-[300px] flex items-center justify-center rounded-2xl border-2 border-dashed border-muted-foreground/30 p-12 text-center outline-none",
                      isSupported
                        ? "hover:border-primary/45 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/25 cursor-pointer"
                        : "cursor-not-allowed opacity-75"
                    )}
                    onPointerEnter={() => isSupported && setIsDropZoneHovered(true)}
                    onPointerMove={() => {
                      if (isSupported && !isDropZoneHovered) {
                        setIsDropZoneHovered(true);
                      }
                    }}
                    onPointerLeave={() => setIsDropZoneHovered(false)}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      if (isSupported) setIsDropZoneHovered(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = isSupported ? 'copy' : 'none';
                      if (isSupported && !isDropZoneHovered) {
                        setIsDropZoneHovered(true);
                      }
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setIsDropZoneHovered(false);
                      }
                    }}
                    onDrop={handleDropZoneDrop}
                    onClick={() =>
                      isSupported &&
                      document.getElementById(mode === 'split' ? 'split-input' : 'videos-input')?.click()
                    }
                    onKeyDown={(e) => {
                      if (isSupported && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        document
                          .getElementById(mode === 'split' ? 'split-input' : 'videos-input')
                          ?.click();
                      }
                    }}
                    tabIndex={isSupported ? 0 : -1}
                    role="button"
                    aria-label={
                      isSupported
                        ? mode === 'split'
                          ? 'Click to upload one long video'
                          : 'Click to upload videos'
                        : 'Browser not supported'
                    }
                    aria-disabled={!isSupported}
                  >
                    <AnimatePresence initial={false} mode="wait">
                    <motion.div
                      key={mode}
                      initial={{ opacity: 0, scale: 0.96, y: 5, filter: 'blur(4px)' }}
                      animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                      exit={{ opacity: 0, scale: 0.98, y: -4, filter: 'blur(3px)' }}
                      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                      className="flex flex-col items-center justify-center gap-4"
                    >
                      {mode === 'split' ? (
                        <Scissors className="motion-icon upload-motion-icon h-10 w-10 text-muted-foreground" />
                      ) : (
                        <Upload className="motion-icon upload-motion-icon h-10 w-10 text-muted-foreground" />
                      )}
                      <div className="flex flex-col items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">
                          {!isSupported
                            ? 'Browser not supported, try Chrome'
                            : mode === 'split'
                              ? 'Upload one long video'
                              : 'Upload your videos'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {!isSupported
                            ? 'WebCodecs API required'
                            : mode === 'split'
                              ? 'MP4, WebM — we’ll cut it into eased sections'
                              : 'MP4, WebM - Select one or more videos'}
                        </p>
                      </div>
                    </motion.div>
                    </AnimatePresence>
                  </div>

                  <AnimatePresence initial={false}>
                    {uploadError && (
                      <motion.p
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="text-center text-sm text-destructive"
                      >
                        {uploadError}
                      </motion.p>
                    )}
                  </AnimatePresence>
                  <motion.p
                    key={mode}
                    initial={{ opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                    className="text-center text-xs text-pretty text-muted-foreground"
                  >
                    {mode === 'split'
                      ? 'Chop one long clip into equal sections and ease each one — great for beat-synced loops.'
                      : 'Combine several short clips into a single eased loop.'}
                  </motion.p>
                </div>
              </BlurFade>
            )}


            {/* Uploaded Videos Preview */}
            {uploadedVideos.length > 0 && (
              <BlurFade key="queue" delay={0.04} className="w-full">
                <div className="w-full space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-balance">
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
                  <motion.div layout className="space-y-3">
                    <AnimatePresence initial={false} mode="popLayout">
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
                            // Only show a note when the device will downscale
                            encodeStatusText = encodeCapability.message?.startsWith('Will render')
                              ? encodeCapability.message
                              : null;
                            encodeStatusClass = 'text-muted-foreground';
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
                        <motion.div
                          layout
                          key={video.id}
                          initial={{ opacity: 0, y: 10, scale: 0.985, filter: 'blur(3px)' }}
                          animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                          exit={{ opacity: 0, y: -6, scale: 0.985, filter: 'blur(2px)' }}
                          transition={{ type: 'spring', duration: 0.34, bounce: 0 }}
                        >
                          <div
                            className={cn(
                              'landing-surface flex items-center gap-3 rounded-xl border border-border/70 bg-secondary/50 p-4 transition-[background-color,box-shadow,transform] duration-200 ease-out',
                              isDragging && 'scale-[0.99] ring-2 ring-primary/40 bg-secondary shadow-xl'
                            )}
                            onDragOver={handleVideoDragOver(index)}
                            onDrop={handleVideoDrop(index)}
                          >


                            <button
                              type="button"
                              className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-border/70 text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary cursor-grab"
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
                            <motion.div
                              layoutId="video-drop-indicator"
                              className="h-0.5 bg-primary mt-2 mb-1 shadow-[0_0_12px_var(--primary)]"
                            />
                          )}
                        </motion.div>
                      );
                    })}
                    </AnimatePresence>
                  </motion.div>

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
                      {!audioExportSupported && (
                        <p className="text-center text-xs text-amber-600 dark:text-amber-400">
                          This browser cannot encode AAC or MP3 audio — videos will export without music.
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
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {Math.round(finalizationProgress)}%
                        </span>
                      </div>
                      <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-primary h-full transition-[width] duration-300"
                          style={{ width: `${finalizationProgress}%` }}
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button variant="outline" size="sm" onClick={handleCancelFinalize}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </BlurFade>
            )}
            </AnimatePresence>

          </>
        )}

        {/* Render failure dialog — outlives the progress modal so errors are actually seen */}
        <Dialog
          open={finalizeError !== null}
          onOpenChange={(open) => {
            if (!open) setFinalizeError(null);
          }}
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Render failed
              </DialogTitle>
              <DialogDescription className="break-words">
                {finalizeError}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFinalizeError(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>

    </div>
    {/* Site credit — landing only, so the editors get the full viewport. */}
    {!(finalVideo || splitSource) && (
      <footer
        className="border-t border-border/50 px-6 py-4 text-[11px] text-muted-foreground tracking-wide"
        style={{ fontFamily: 'var(--font-dm-mono)' }}
      >
        By Willie —{' '}
        <a
          href="https://github.com/shrimbly/easy-peasy-ease"
          className="inline-block underline transition-[color,transform] duration-150 hover:-translate-y-px hover:text-foreground focus-visible:text-foreground"
          target="_blank"
          rel="noreferrer"
        >
          code
        </a>{' '}
        —{' '}
        <a
          href="https://x.com/ReflctWillie"
          className="inline-block underline transition-[color,transform] duration-150 hover:-translate-y-px hover:text-foreground focus-visible:text-foreground"
          target="_blank"
          rel="noreferrer"
        >
          x
        </a>
      </footer>
    )}
    </div>
  );
}
