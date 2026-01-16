import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { CubicBezierEditor } from '@/components/CubicBezierEditor';
import { TransitionVideo } from '@/lib/types';

interface SegmentSettingsPanelProps {
    selectedSegment: TransitionVideo | null;
    easingOptions: string[];
    applyAll: boolean;
    onApplyAllChange: (checked: boolean) => void;
    onDurationChange: (id: number, duration: number, applyAll?: boolean) => void;
    onPresetChange: (id: number, preset: string, applyAll?: boolean) => void;
    onBezierChange: (nextValue: [number, number, number, number]) => void;
    onBezierCommit: (finalValue: [number, number, number, number]) => void;
    curveValue: [number, number, number, number];
    onUpdateVideo: () => void;
    isUpdating: boolean;
}

export function SegmentSettingsPanel({
    selectedSegment,
    easingOptions,
    applyAll,
    onApplyAllChange,
    onDurationChange,
    onPresetChange,
    onBezierChange,
    onBezierCommit,
    curveValue,
    onUpdateVideo,
    isUpdating,
}: SegmentSettingsPanelProps) {
    if (!selectedSegment) {
        return (
            <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <p>Select a segment in the timeline to edit its timing and ease curve.</p>
            </div>
        );
    }

    return (
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
                        step={0.01}
                        value={selectedSegment.duration ?? 1.5}
                        onChange={(event) =>
                            onDurationChange(selectedSegment.id, Number(event.target.value), applyAll)
                        }
                        className="h-2 flex-1 cursor-pointer rounded-full bg-primary/30"
                    />
                    <input
                        type="number"
                        min={0.1}
                        step={0.01}
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
                    onChange={onBezierChange}
                    onCommit={onBezierCommit}
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
                        onChange={(event) => onApplyAllChange(event.target.checked)}
                        className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    Apply settings to all videos
                </label>
                <Button
                    size="sm"
                    onClick={onUpdateVideo}
                    disabled={isUpdating}
                    className="gap-2 w-full mt-2"
                >
                    {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
                    {isUpdating ? 'Updating…' : 'Update Video'}
                </Button>
            </div>
        </>
    );
}
