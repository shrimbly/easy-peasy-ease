"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

const segmentedControlClassName =
  "landing-surface relative isolate inline-grid h-10 grid-cols-2 rounded-lg border border-border/70 bg-secondary/40 p-1";

const segmentedControlItemClassName =
  "relative z-10 inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-sm font-medium text-muted-foreground transition-[color,scale] duration-200 ease-out before:absolute before:inset-x-0 before:inset-y-[-4px] before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset data-[state=active]:bg-transparent data-[state=active]:text-primary-foreground data-[state=active]:shadow-none aria-pressed:text-primary-foreground";

interface SegmentedControlIndicatorProps {
  activeIndex: 0 | 1;
  className?: string;
}

function SegmentedControlIndicator({
  activeIndex,
  className,
}: SegmentedControlIndicatorProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.span
      aria-hidden="true"
      initial={false}
      animate={{ x: activeIndex === 0 ? "0%" : "100%" }}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : { type: "tween", duration: 0.24, ease: "easeOut" }
      }
      className={cn(
        "pointer-events-none absolute inset-y-1 left-1 z-0 w-[calc(50%_-_0.25rem)] rounded-md bg-primary shadow-sm",
        className
      )}
    />
  );
}

interface SegmentedControlProps extends React.ComponentProps<"div"> {
  activeIndex: 0 | 1;
}

function SegmentedControl({
  activeIndex,
  className,
  children,
  ...props
}: SegmentedControlProps) {
  return (
    <div className={cn(segmentedControlClassName, className)} {...props}>
      <SegmentedControlIndicator activeIndex={activeIndex} />
      {children}
    </div>
  );
}

export {
  SegmentedControl,
  SegmentedControlIndicator,
  segmentedControlClassName,
  segmentedControlItemClassName,
};
