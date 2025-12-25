import { Label } from '@/components/ui/label';
import { AudioProcessingOptions } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface AudioSettingsPanelProps {
    audioSettings: AudioProcessingOptions;
    onUpdateSetting: (property: 'fadeIn' | 'fadeOut', value: number) => void;
    onCommit: () => void;
    isUpdating: boolean;
}

export function AudioSettingsPanel({
    audioSettings,
    onUpdateSetting,
    onCommit,
    isUpdating,
}: AudioSettingsPanelProps) {
    return (
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
                        onChange={(event) => onUpdateSetting('fadeIn', Number(event.target.value))}
                        className="h-2 flex-1 cursor-pointer rounded-full bg-primary/30"
                    />
                    <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.1}
                        value={audioSettings.fadeIn}
                        onChange={(event) => onUpdateSetting('fadeIn', Number(event.target.value))}
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
                        onChange={(event) => onUpdateSetting('fadeOut', Number(event.target.value))}
                        className="h-2 flex-1 cursor-pointer rounded-full bg-primary/30"
                    />
                    <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.1}
                        value={audioSettings.fadeOut}
                        onChange={(event) => onUpdateSetting('fadeOut', Number(event.target.value))}
                        className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm"
                    />
                </div>
            </div>

            <Button
                size="sm"
                onClick={onCommit}
                disabled={isUpdating}
                className="gap-2 w-full"
            >
                {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
                {isUpdating ? 'Updating.' : 'Update Video'}
            </Button>
        </div>
    );
}
