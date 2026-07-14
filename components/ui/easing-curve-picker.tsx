'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { getPresetBezier } from '@/lib/easing-presets';

const POPOVER_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];
const POPOVER_ROW_REVEAL_DURATION = 0.18;
const POPOVER_ROW_STAGGER = 0.035;
const CURVES_PER_ROW = 3;

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
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const shouldReduceMotion = useReducedMotion();
  const selectedOptionIndex = Math.max(0, options.indexOf(value));
  const [focusedOptionIndex, setFocusedOptionIndex] = useState(selectedOptionIndex);
  const rovingOptionIndex =
    options.length === 0
      ? -1
      : Math.max(0, Math.min(options.length - 1, focusedOptionIndex));
  const optionRows = Array.from(
    { length: Math.ceil(options.length / CURVES_PER_ROW) },
    (_, rowIndex) =>
      options.slice(rowIndex * CURVES_PER_ROW, (rowIndex + 1) * CURVES_PER_ROW)
  );

  useEffect(() => {
    if (!open || options.length === 0) return;
    const frameId = requestAnimationFrame(() => {
      optionRefs.current[rovingOptionIndex]?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [open, options.length, rovingOptionIndex]);

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

  const selectCurve = (preset: string, index: number) => {
    setFocusedOptionIndex(index);
    onChange(preset);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleOptionKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLButtonElement>
  ) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = index + 1;
    if (event.key === 'ArrowLeft') nextIndex = index - 1;
    if (event.key === 'ArrowDown') nextIndex = index + CURVES_PER_ROW;
    if (event.key === 'ArrowUp') nextIndex = index - CURVES_PER_ROW;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = options.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const clampedIndex = Math.max(0, Math.min(options.length - 1, nextIndex));
    setFocusedOptionIndex(clampedIndex);
    optionRefs.current[clampedIndex]?.focus();
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
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "relative flex h-9 items-center gap-2 rounded-md border border-border bg-background py-0 pl-2 pr-2.5 text-sm text-foreground transition-colors after:absolute after:inset-x-0 after:inset-y-[-2px] after:content-[''] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50",
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

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="curve-picker-popover"
            id={popoverId}
            role="listbox"
            aria-label="Ease curves"
            initial={
              shouldReduceMotion
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    transform: 'scaleY(0.75)',
                    filter: 'blur(4px)',
                  }
            }
            animate={
              shouldReduceMotion
                ? { opacity: 1 }
                : {
                    opacity: 1,
                    transform: 'scaleY(1)',
                    filter: 'blur(0px)',
                  }
            }
            exit={
              shouldReduceMotion
                ? {
                    opacity: 0,
                    transition: { duration: 0.12, ease: POPOVER_EASE },
                  }
                : {
                    opacity: 0,
                    transform: 'scaleY(0.9)',
                    filter: 'blur(2px)',
                    transition: {
                      duration: 0.14,
                      ease: POPOVER_EASE,
                    },
                  }
            }
            transition={{
              duration: shouldReduceMotion ? 0.12 : 0.22,
              ease: POPOVER_EASE,
            }}
            style={{ transformOrigin: align === 'end' ? 'top right' : 'top left' }}
            className={cn(
              'absolute top-full z-50 mt-2 max-h-[min(60vh,420px)] w-72 overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-xl',
              align === 'end' ? 'right-0' : 'left-0'
            )}
          >
            <div className="flex flex-col gap-1.5">
              {optionRows.map((row, rowIndex) => (
                <motion.div
                  key={`curve-row-${row[0]}`}
                  role="presentation"
                  initial={
                    shouldReduceMotion
                      ? { opacity: 0 }
                      : { opacity: 0, filter: 'blur(3px)' }
                  }
                  animate={
                    shouldReduceMotion
                      ? { opacity: 1 }
                      : { opacity: 1, filter: 'blur(0px)' }
                  }
                  transition={{
                    duration: shouldReduceMotion
                      ? 0.12
                      : POPOVER_ROW_REVEAL_DURATION,
                    delay: shouldReduceMotion
                      ? 0
                      : rowIndex * POPOVER_ROW_STAGGER,
                    ease: POPOVER_EASE,
                  }}
                  className="grid grid-cols-3 gap-1.5"
                >
                  {row.map((preset, optionIndex) => {
                    const index = rowIndex * CURVES_PER_ROW + optionIndex;
                    const selected = preset === value;
                    return (
                      <button
                        ref={(element) => {
                          optionRefs.current[index] = element;
                        }}
                        key={preset}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        tabIndex={index === rovingOptionIndex ? 0 : -1}
                        onClick={() => selectCurve(preset, index)}
                        onKeyDown={(event) => handleOptionKeyDown(index, event)}
                        className={cn(
                          'flex flex-col items-center gap-1 rounded-sm border p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset',
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
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
