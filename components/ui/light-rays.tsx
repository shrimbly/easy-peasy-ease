"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { motion, useMotionValue, useMotionTemplate, animate, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"

interface LightRaysProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
> {
  ref?: React.Ref<HTMLDivElement>
  count?: number
  color?: string
  blur?: number
  speed?: number
  length?: string
  interactive?: boolean
}

type LightRay = {
  id: string
  left: number
  rotate: number
  width: number
  swing: number
  delay: number
  duration: number
  intensity: number
}

const createRays = (count: number, cycle: number): LightRay[] => {
  if (count <= 0) return []

  return Array.from({ length: count }, (_, index) => {
    const left = 8 + Math.random() * 84
    const rotate = -28 + Math.random() * 56
    const width = 160 + Math.random() * 160
    const swing = 0.8 + Math.random() * 1.8
    const delay = Math.random() * cycle
    const duration = cycle * (0.75 + Math.random() * 0.5)
    const intensity = 0.6 + Math.random() * 0.5

    return {
      id: `${index}-${Math.round(left * 10)}`,
      left,
      rotate,
      width,
      swing,
      delay,
      duration,
      intensity,
    }
  })
}

const Ray = ({
  left,
  rotate,
  width,
  swing,
  delay,
  duration,
  intensity,
  reduceMotion,
}: LightRay & { reduceMotion: boolean }) => {
  return (
    <motion.div
      className="pointer-events-none absolute -top-[12%] left-[var(--ray-left)] h-[var(--light-rays-length)] w-[var(--ray-width)] origin-top -translate-x-1/2 rounded-full bg-gradient-to-b from-[color-mix(in_srgb,var(--light-rays-color)_70%,transparent)] to-transparent opacity-0 mix-blend-screen blur-[var(--light-rays-blur)]"
      style={
        {
          "--ray-left": `${left}%`,
          "--ray-width": `${width}px`,
        } as CSSProperties
      }
      initial={{ rotate: rotate }}
      animate={reduceMotion ? { opacity: intensity * 0.45, rotate } : {
        opacity: [0, intensity, 0],
        rotate: [rotate - swing, rotate + swing, rotate - swing],
      }}
      transition={reduceMotion ? { duration: 0 } : {
        duration: duration,
        repeat: Infinity,
        ease: "easeInOut",
        delay: delay,
        repeatDelay: duration * 0.1,
      }}
    />
  )
}

const HoverBeam = ({
  active,
  reduceMotion,
}: {
  active: boolean
  reduceMotion: boolean
}) => {
  const opacity = useMotionValue(0)

  useEffect(() => {
    const opacityAnimation = animate(
      opacity,
      active && !reduceMotion ? 0.36 : 0,
      {
        duration: active ? 0.75 : 0.45,
        ease: active ? [0.22, 1, 0.36, 1] : "easeInOut",
      }
    )

    return () => opacityAnimation.stop()
  }, [active, opacity, reduceMotion])

  return (
    <motion.div aria-hidden className="pointer-events-none absolute inset-0">
      <motion.div
        data-hover-beam="true"
        className="absolute -top-[10%] left-1/2 h-[105vh] w-[clamp(220px,28vw,420px)] -translate-x-1/2"
        style={{
          opacity,
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(202, 222, 234, 0.22) 0%, rgba(202, 222, 234, 0.218) 8%, rgba(202, 222, 234, 0.208) 15%, rgba(202, 222, 234, 0.192) 22%, rgba(202, 222, 234, 0.168) 30%, rgba(202, 222, 234, 0.134) 38%, rgba(202, 222, 234, 0.1) 47%, rgba(202, 222, 234, 0.067) 56%, rgba(202, 222, 234, 0.04) 65%, rgba(202, 222, 234, 0.021) 73%, rgba(202, 222, 234, 0.008) 80%, rgba(202, 222, 234, 0) 87%, rgba(202, 222, 234, 0) 100%)",
        }}
      />
      <motion.div
        data-hover-bloom="true"
        className="absolute left-1/2 top-[46%] h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full blur-2xl"
        style={{
          opacity,
          background:
            "radial-gradient(circle, rgba(202, 222, 234, 0.07) 0%, rgba(202, 222, 234, 0.057) 22%, rgba(202, 222, 234, 0.035) 42%, rgba(202, 222, 234, 0.016) 60%, rgba(202, 222, 234, 0.005) 76%, rgba(202, 222, 234, 0) 90%)",
        }}
      />
    </motion.div>
  )
}

export function LightRays({
  className,
  style,
  count = 7,
  color = "rgba(160, 210, 255, 0.2)",
  blur = 36,
  speed = 14,
  length = "70vh",
  interactive = false,
  ref,
  ...props
}: LightRaysProps) {
  const [rays, setRays] = useState<LightRay[]>([])
  const shouldReduceMotion = useReducedMotion()
  const opacityValue = useMotionValue(0.15)
  const cycleDuration = Math.max(speed, 0.1)

  // Extract opacity from color string and animate it
  useEffect(() => {
    const match = color.match(/[\d.]+\)$/)
    if (match) {
      const opacity = parseFloat(match[0])
      animate(opacityValue, opacity, {
        duration: shouldReduceMotion ? 0 : 0.9,
        ease: "easeInOut",
      })
    }
  }, [color, opacityValue, shouldReduceMotion])

  useEffect(() => {
    setRays(createRays(count, cycleDuration))
  }, [count, cycleDuration])

  const animatedColor = useMotionTemplate`rgba(160, 210, 255, ${opacityValue})`

  return (
    <motion.div
      ref={ref}
      className={cn(
        "pointer-events-none absolute inset-0 isolate overflow-hidden rounded-[inherit]",
        className
      )}
      style={
        {
          "--light-rays-color": animatedColor,
          "--light-rays-blur": `${blur}px`,
          "--light-rays-length": length,
          ...style,
        } as CSSProperties
      }
      transition={{ duration: 0.9, ease: "easeInOut" }}
      {...props}
    >
      <div className="absolute inset-0 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={
            {
              background:
                "radial-gradient(circle at 20% 15%, color-mix(in srgb, var(--light-rays-color) 45%, transparent), transparent 70%)",
            } as CSSProperties
          }
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={
            {
              background:
                "radial-gradient(circle at 80% 10%, color-mix(in srgb, var(--light-rays-color) 35%, transparent), transparent 75%)",
            } as CSSProperties
          }
        />
        {rays.map((ray) => (
          <Ray key={ray.id} {...ray} reduceMotion={Boolean(shouldReduceMotion)} />
        ))}
        <HoverBeam
          active={interactive}
          reduceMotion={Boolean(shouldReduceMotion)}
        />
      </div>
    </motion.div>
  )
}
