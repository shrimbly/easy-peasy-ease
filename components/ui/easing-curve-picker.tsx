'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPresetBezier } from '@/lib/easing-presets';

interface EasingCurvePickerProps {
  value: string;
  options: string[];
  onChange: (preset: string) => void;
  disabled?: boolean;
  id?: string;
  /** Which edge of the trigger the popover panel hangs from. */
  align?: 'start' | 'end';
  /** Stretch the trigger to fill its row (used in stacked layouts). */
  fullWidth?: boolean;
}

/** Tiny cubic-bezier preview: dashed linear reference + the curve itself. */
function CurveThumb({
  bezier,
  className,
}: {
  bezier: [number, number, number, number];
  className?: string;
}) {
  const [x1, y1, x2, y2] = bezier;
  const d = `M0,100 C${x1 * 100},${100 - y1 * 100} ${x2 * 100},${100 - y2 * 100} 100,0`;
  return (
    // Padded viewBox so strokes at the corners don't clip.
    <svg viewBox="-8 -8 116 116" className={className} aria-hidden="true">
      <line
        x1="0"
        y1="100"
        x2="100"
        y2="0"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="4"
        strokeDasharray="7 7"
      />
      <path
        d={d}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Ease-curve selector: a trigger showing the current curve, opening a grid
 * popover of thumbnail previews (one per preset).
 */
export function EasingCurvePicker({
  value,
  options,
  onChange,
  disabled = false,
  id,
  align = 'end',
  fullWidth = false,
}: EasingCurvePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside interaction or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const selectCurve = (preset: string) => {
    onChange(preset);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={rootRef} className={cn('relative', fullWidth && 'w-full')}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex items-center gap-2 rounded-md border border-border bg-background py-1.5 pl-2 pr-2.5 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
          fullWidth && 'w-full'
        )}
      >
        <CurveThumb bezier={getPresetBezier(value)} className="h-5 w-5 shrink-0" />
        <span className="truncate">{value}</span>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Ease curves"
          className={cn(
            'absolute top-full z-50 mt-2 max-h-[min(60vh,420px)] w-72 overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-xl',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          <div className="grid grid-cols-3 gap-1.5">
            {options.map((preset) => {
              const selected = preset === value;
              return (
                <button
                  key={preset}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectCurve(preset)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-sm border p-2 transition-colors',
                    selected
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-transparent hover:bg-accent'
                  )}
                >
                  <CurveThumb bezier={getPresetBezier(preset)} className="h-10 w-10" />
                  <span
                    className={cn(
                      'text-center text-[10px] leading-tight',
                      selected ? 'font-medium text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {preset}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
