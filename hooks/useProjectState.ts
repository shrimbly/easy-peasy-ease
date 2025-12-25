import { useState, useRef, useCallback, useEffect } from 'react';
import {
    TransitionVideo,
    FinalVideo,
    SpeedCurvedBlobCache,
    AudioProcessingOptions,
} from '@/lib/types';
import {
    DEFAULT_EASING,
    getPresetBezier,
} from '@/lib/easing-presets';
import {
    readVideoMetadata,
    getCodecStringForResolution,
    estimateBitrateForResolution,
} from '@/lib/project-service';
import { canEncodeVideo } from 'mediabunny';

export function useProjectState() {
    const [uploadedVideos, setUploadedVideos] = useState<File[]>([]);
    const [transitionVideos, setTransitionVideos] = useState<TransitionVideo[]>([]);
    const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null);
    const [loopCount, setLoopCount] = useState(1);
    const [finalVideo, setFinalVideo] = useState<FinalVideo | null>(null);
    const [isFinalizingVideo, setIsFinalizingVideo] = useState(false);
    const [finalizationProgress, setFinalizationProgress] = useState(0);
    const [finalizationMessage, setFinalizationMessage] = useState('');

    // Cache for speed-curved blobs
    const [speedCurveCache, setSpeedCurveCache] = useState<SpeedCurvedBlobCache | null>(null);

    // Refs for tracking previous values
    const prevAudioBlobRef = useRef<Blob | null>(null);
    const prevAudioSettingsRef = useRef<AudioProcessingOptions | null>(null);
    const transitionVideosRef = useRef<TransitionVideo[]>([]);

    useEffect(() => {
        transitionVideosRef.current = transitionVideos;
    }, [transitionVideos]);

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

    // Cleanup on unmount
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
                    if (!blobSource) return;
                    const segmentId = segment.id;

                    setTransitionVideos((prev) => {
                        if (!prev.some((v) => v.id === segmentId)) return prev;
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
                            if (!prev.some((v) => v.id === segmentId)) return prev;
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
                        const errorMessage = error instanceof Error ? error.message : 'Unable to verify encode capability';
                        setTransitionVideos((prev) => {
                            if (!prev.some((v) => v.id === segmentId)) return prev;
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
        []
    );

    const addVideos = useCallback(
        async (files: FileList | null, append: boolean = false) => {
            if (!(files && files[0])) return;

            const videoFiles = Array.from(files).filter((f) => f.type.startsWith('video/'));
            if (videoFiles.length === 0) return;

            if (append) {
                setUploadedVideos((prev) => [...prev, ...videoFiles]);
            } else {
                setUploadedVideos(videoFiles);
            }

            try {
                const nextIdStart = append
                    ? Math.max(0, ...transitionVideos.map((v) => v.id)) + 1
                    : 1;

                const preparedSegments = await Promise.all(
                    videoFiles.map(async (file, index) => {
                        const buffer = await file.arrayBuffer();
                        const cachedBlob = new Blob([buffer], { type: file.type || 'video/mp4' });
                        const objectUrl = URL.createObjectURL(cachedBlob);

                        return {
                            id: nextIdStart + index,
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
                    if (!append) {
                        cleanupSegmentResources(prev);
                        return preparedSegments;
                    }
                    return [...prev, ...preparedSegments];
                });

                if (!append) {
                    setLoopCount(1);
                    setSelectedSegmentId(preparedSegments[0]?.id ?? null);
                }

                // Clear cache
                setSpeedCurveCache(null);
                prevAudioBlobRef.current = null;
                prevAudioSettingsRef.current = null;

                void evaluateVideoEncodeCapability(preparedSegments);
            } catch (error) {
                console.error('Failed to process uploaded videos', error);
            }
        },
        [transitionVideos, cleanupSegmentResources, evaluateVideoEncodeCapability]
    );

    const resetProject = useCallback(() => {
        setUploadedVideos([]);
        setTransitionVideos((prev) => {
            cleanupSegmentResources(prev);
            return [];
        });
        setFinalVideo(null);
        setSelectedSegmentId(null);
        setLoopCount(1);
        setSpeedCurveCache(null);
        prevAudioBlobRef.current = null;
        prevAudioSettingsRef.current = null;
    }, [cleanupSegmentResources]);

    const removeVideo = useCallback((id: number, name: string) => {
        setTransitionVideos((prev) => {
            const target = prev.find((v) => v.id === id);
            if (target) {
                cleanupSegmentResources([target]);
            }
            return prev.filter((v) => v.id !== id);
        });
        setUploadedVideos((prev) => prev.filter((f) => f.name !== name));
    }, [cleanupSegmentResources]);

    const updateSegmentMetadata = useCallback((
        id: number,
        updates: Partial<TransitionVideo>,
        applyAll: boolean = false
    ) => {
        setTransitionVideos((prev) =>
            prev.map((segment) => {
                const shouldUpdate = applyAll || segment.id === id;
                if (!shouldUpdate) return segment;

                const nextUpdates = { ...updates };
                if (updates.customBezier) {
                    nextUpdates.customBezier = [...updates.customBezier] as [number, number, number, number];
                }
                return { ...segment, ...nextUpdates };
            })
        );
    }, []);

    return {
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
        cleanupSegmentResources, // exposed if needed
    };
}
