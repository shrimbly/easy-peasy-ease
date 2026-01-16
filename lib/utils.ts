import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function calculateAspectRatioConsistency(videos: { width: number; height: number }[]): number {
  if (videos.length <= 1) return 100;

  const ratios = videos.map((v) => {
    // Round to 2 decimal places to be tolerant of minor differences
    return Number((v.width / v.height).toFixed(2));
  });

  const counts: Record<number, number> = {};
  let maxCount = 0;

  for (const r of ratios) {
    counts[r] = (counts[r] || 0) + 1;
    if (counts[r] > maxCount) {
      maxCount = counts[r];
    }
  }

  return Math.round((maxCount / videos.length) * 100);
}
