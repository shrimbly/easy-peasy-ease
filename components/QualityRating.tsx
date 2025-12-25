import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TransitionVideo } from '@/lib/types';

interface QualityRatingProps {
    segments: TransitionVideo[];
}

export function QualityRating({ segments }: QualityRatingProps) {
    const validSegments = segments
        .filter((s) => s.width && s.height)
        .map((s) => {
            const r = s.width! / s.height!;
            return { r: Number(r.toFixed(2)), label: `${s.width}x${s.height}` };
        });

    if (validSegments.length <= 1) return null;

    const counts: Record<number, number> = {};
    for (const { r } of validSegments) {
        counts[r] = (counts[r] || 0) + 1;
    }

    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const maxCount = entries[0][1];
    const consistency = Math.round((maxCount / validSegments.length) * 100);

    if (consistency >= 100) return null;

    // Generate breakdown string
    const breakdown = entries.map(([ratio, count]) => {
        const rVal = Number(ratio);
        let label = `${rVal}:1`;
        if (Math.abs(rVal - 1.78) < 0.05) label = "16:9 (Landscape)";
        else if (Math.abs(rVal - 0.56) < 0.05) label = "9:16 (Portrait)";
        else if (Math.abs(rVal - 1.0) < 0.05) label = "1:1 (Square)";
        else if (Math.abs(rVal - 1.33) < 0.05) label = "4:3";

        return `${count} video${count === 1 ? '' : 's'} are ${label}`;
    }).join(', ');

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2.5 py-1 text-yellow-600 border border-yellow-500/20 cursor-help">
                        <span className="h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse" />
                        <span>Quality: {consistency}%</span>
                    </div>
                </TooltipTrigger>
                <TooltipContent>
                    <p className="max-w-xs">
                        Mixed Aspect Ratios detected. Breakdown: {breakdown}. For best results, use consistent aspect ratios.
                    </p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
