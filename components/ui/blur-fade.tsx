"use client"

import { useRef } from "react"
import {
  motion,
  MotionProps,
  useInView,
  useReducedMotion,
  UseInViewOptions,
  Variants,
} from "motion/react"

type MarginType = UseInViewOptions["margin"]

interface BlurFadeProps extends MotionProps {
  children: React.ReactNode
  className?: string
  variant?: {
    hidden: { y?: number; x?: number; opacity?: number; filter?: string }
    visible: { y?: number; x?: number; opacity?: number; filter?: string }
  }
  duration?: number
  delay?: number
  offset?: number
  direction?: "up" | "down" | "left" | "right"
  inView?: boolean
  inViewMargin?: MarginType
  blur?: string
}

export function BlurFade({
  children,
  className,
  variant,
  duration = 0.4,
  delay = 0,
  offset = 6,
  direction = "down",
  inView = false,
  inViewMargin = "-50px",
  blur = "6px",
  ...props
}: BlurFadeProps) {
  const ref = useRef(null)
  const shouldReduceMotion = useReducedMotion()
  const inViewResult = useInView(ref, { once: true, margin: inViewMargin })
  const isInView = !inView || inViewResult
  const defaultVariants: Variants = {
    hidden: {
      [direction === "left" || direction === "right" ? "x" : "y"]:
        direction === "right" || direction === "down" ? -offset : offset,
      opacity: 0,
      filter: `blur(${blur})`,
    },
    visible: {
      [direction === "left" || direction === "right" ? "x" : "y"]: 0,
      opacity: 1,
      filter: `blur(0px)`,
    },
  }
  const combinedVariants = variant || defaultVariants
  return (
    <motion.div
      ref={ref}
      initial={shouldReduceMotion ? false : "hidden"}
      animate={isInView ? "visible" : "hidden"}
      exit={shouldReduceMotion ? undefined : {
        opacity: 0,
        y: -6,
        filter: "blur(3px)",
        transition: { duration: 0.15, ease: "easeIn" },
      }}
      variants={combinedVariants}
      transition={shouldReduceMotion ? { duration: 0 } : {
        delay: 0.04 + delay,
        duration,
        ease: [0.22, 1, 0.36, 1],
      }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  )
}
