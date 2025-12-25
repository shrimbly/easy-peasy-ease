import { useState } from 'react';
import {
    GripVertical,
    Play,
    PlayCircle,
    Plus,
    Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BlurFade } from '@/components/ui/blur-fade';
import { TransitionVideo, FinalVideo } from '@/lib/types';
import { formatResolutionLabel } from '@/lib/project-service';

interface VideoListProps {
    uploadedVideosCount: number;
    transitionVideos: TransitionVideo[];
    isSupported: boolean;
    isFinalizing: boolean;
    finalVideo: FinalVideo | null;
    onAddVideos: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onReset: () => void;
    onRemoveVideo: (id: number, name: string) => void;
    onPlayVideo: (video: TransitionVideo) => void;
    onReorder: (fromIndex: number, toIndex: number) => void;
    onFinalize: () => void;
    encodeWarnings: string[];
    encodeErrors: string[];
    hasPendingEncodeChecks: boolean;
    onFilesDropped: (files: FileList) => void;
    finalizationProgress: number;
    finalizationMessage: string;
}

export function VideoList({
    uploadedVideosCount,
    transitionVideos,
    isSupported,
    isFinalizing,
    finalVideo,
    onAddVideos,
    onReset,
    onRemoveVideo,
    onPlayVideo,
    onReorder,
    onFinalize,
    encodeWarnings,
    encodeErrors,
    hasPendingEncodeChecks,
    onFilesDropped,
    finalizationProgress,
    finalizationMessage,
}: VideoListProps) {
    const [draggingVideoIndex, setDraggingVideoIndex] = useState<number | null>(null);
    const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(null);
    const [isFileDragOver, setIsFileDragOver] = useState(false);

    const handleVideoDragStart = (index: number) => (event: React.DragEvent<HTMLButtonElement>) => {
        setDraggingVideoIndex(index);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', index.toString());
    };

    const handleVideoDragOver = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
        // If it's a file drag, let the container handle it (propagate up) if we aren't reordering
        if (draggingVideoIndex === null) {
            return;
        }

        event.preventDefault();
        event.stopPropagation(); // Stop propagation only if we are handling reordering

        if (draggingVideoIndex === index) {
            setDropIndicatorIndex(null);
            return;
        }
        event.dataTransfer.dropEffect = 'move';
        setDropIndicatorIndex(index);
    };

    const handleVideoDrop = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
        if (draggingVideoIndex === null) return; // Files handled by container

        event.preventDefault();
        event.stopPropagation();

        const sourceIndex =
            draggingVideoIndex ?? Number.parseInt(event.dataTransfer.getData('text/plain'), 10);

        if (Number.isNaN(sourceIndex) || sourceIndex === index) {
            setDraggingVideoIndex(null);
            setDropIndicatorIndex(null);
            return;
        }

        onReorder(sourceIndex, index);
        setDraggingVideoIndex(null);
        setDropIndicatorIndex(null);
    };

    const handleVideoDragEnd = () => {
        setDraggingVideoIndex(null);
        setDropIndicatorIndex(null);
    };

    // Container handlers for file drop
    const handleContainerDragOver = (e: React.DragEvent) => {
        if (draggingVideoIndex !== null) return; // Ignore if reordering internally

        if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setIsFileDragOver(true);
        }
    };

    const handleContainerDragLeave = (e: React.DragEvent) => {
        // Avoid flickering when entering children
        if (e.currentTarget.contains(e.relatedTarget as Node)) {
            return;
        }
        setIsFileDragOver(false);
    };

    const handleContainerDrop = (e: React.DragEvent) => {
        if (draggingVideoIndex !== null) return;

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            e.preventDefault();
            setIsFileDragOver(false);
            onFilesDropped(e.dataTransfer.files);
        }
    };

    return (
        <BlurFade delay={0.2} className="w-full">
            <div
                className="w-full space-y-6 relative"
                onDragOver={handleContainerDragOver}
                onDragLeave={handleContainerDragLeave}
                onDrop={handleContainerDrop}
            >
                {/* Drag Overlay */}
                {isFileDragOver && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 backdrop-blur-sm transition-all animate-in fade-in-0 duration-200">
                        <div className="flex flex-col items-center gap-4 text-center p-8">
                            <div className="rounded-full bg-primary/10 p-4">
                                <Plus className="h-8 w-8 text-primary" />
                            </div>
                            <div>
                                <h3 className="text-lg font-semibold">Drop videos here</h3>
                                <p className="text-sm text-muted-foreground">to add them to your list</p>
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">
                        Uploaded Videos ({uploadedVideosCount})
                    </h3>
                    <div className="flex gap-2">
                        <input
                            type="file"
                            accept="video/*"
                            onChange={(event) => {
                                onAddVideos(event);
                            }}
                            className="hidden"
                            id="add-videos-input"
                            multiple
                            disabled={!isSupported}
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => document.getElementById('add-videos-input')?.click()}
                        >
                            <Plus className="h-4 w-4 mr-2" />
                            Add Video
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onReset}
                        >
                            Reset
                        </Button>
                    </div>
                </div>

                {/* Videos List with Reordering */}
                <div className="space-y-3">
                    {/* Empty state for list if count is 0, though parent handles that */}

                    {transitionVideos.map((video, index) => {
                        const isDragging = draggingVideoIndex === index;
                        // ... (rest of status logic)
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
                                        onClick={() => onPlayVideo(video)}
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
                                        onClick={() => onRemoveVideo(video.id, video.name)}
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
                {transitionVideos.every((v) => v.url && !v.loading) && !isFinalizing && (
                    <div className="space-y-3">
                        <div className="flex justify-center">
                            <Button
                                size="lg"
                                onClick={onFinalize}
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
                {isFinalizing && (
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
    );
}
