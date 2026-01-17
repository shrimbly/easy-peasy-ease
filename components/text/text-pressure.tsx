"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface TextPressureProps {
  text: string;
  fontFamily?: string;
  fontUrl?: string;
  width?: boolean;
  weight?: boolean;
  italic?: boolean;
  alpha?: boolean;
  flex?: boolean;
  stroke?: boolean;
  scale?: boolean;
  textColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  minFontSize?: number;
  className?: string;
}

const TextPressure = ({
  text,
  fontFamily = "Inter Variable",
  fontUrl,
  width = true,
  weight = true,
  italic = true,
  alpha = false,
  flex = true,
  stroke = false,
  scale = false,
  textColor = "currentColor",
  strokeColor = "#FF0000",
  strokeWidth = 2,
  minFontSize = 24,
  className,
}: TextPressureProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const charsRef = useRef<HTMLSpanElement[]>([]);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isAnimating, setIsAnimating] = useState(true);

  // Load custom font if provided
  useEffect(() => {
    if (!fontUrl) return;

    const style = document.createElement("style");
    style.textContent = `
      @font-face {
        font-family: "${fontFamily}";
        src: url('${fontUrl}') format('woff2');
        font-variation-settings: "wght" 100 900, "wdth" 5 200;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, [fontUrl, fontFamily]);

  // Initial animation - simulate mouse drag left to right
  useEffect(() => {
    if (!isAnimating || !containerRef.current) return;

    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    const startX = containerRect.left - 100;
    const endX = containerRect.right + 100;
    const centerY = containerRect.top + containerRect.height / 2;

    // Animation duration in milliseconds (easing in and out)
    const duration = 2000;
    const startTime = Date.now();

    const animateMouseDrag = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-in-out sine function (gentle start and end, slower middle)
      const easeInOutSine = (t: number) => {
        return -(Math.cos(Math.PI * t) - 1) / 2;
      };

      const easedProgress = easeInOutSine(progress);
      const x = startX + (endX - startX) * easedProgress;

      setMousePos({ x, y: centerY });

      if (progress < 1) {
        requestAnimationFrame(animateMouseDrag);
      } else {
        setIsAnimating(false);
      }
    };

    const animationFrame = requestAnimationFrame(animateMouseDrag);
    return () => cancelAnimationFrame(animationFrame);
  }, [isAnimating]);

  // Handle mouse movement
  useEffect(() => {
    if (isAnimating) return;

    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [isAnimating]);

  // Update character styles based on cursor proximity
  useEffect(() => {
    const updateCharacters = () => {
      if (!containerRef.current || charsRef.current.length === 0) return;

      charsRef.current.forEach((char) => {
        if (!char) return;

        const rect = char.getBoundingClientRect();
        const charCenterX = rect.left + rect.width / 2;
        const charCenterY = rect.top + rect.height / 2;

        // Calculate distance from cursor to character center
        const distance = Math.sqrt(
          Math.pow(mousePos.x - charCenterX, 2) +
            Math.pow(mousePos.y - charCenterY, 2)
        );

        // Maximum distance for effect (in pixels)
        const maxDistance = 150;
        const influence = Math.max(0, 1 - distance / maxDistance);

        // Apply font variations
        let fontVariationSettings = "";

        if (weight) {
          // Reverse: start at 900 (super bold), thin to 400 on hover
          const weightValue = 900 - influence * 500; // 900-400
          fontVariationSettings += `"wght" ${weightValue}`;
        }

        if (width) {
          const widthValue = 100 + influence * 50; // 100-150%
          if (fontVariationSettings) fontVariationSettings += ", ";
          fontVariationSettings += `"wdth" ${widthValue}`;
        }

        if (italic) {
          const italicValue = influence; // 0-1
          if (fontVariationSettings) fontVariationSettings += ", ";
          fontVariationSettings += `"ital" ${italicValue}`;
        }

        if (fontVariationSettings) {
          char.style.fontVariationSettings = fontVariationSettings;
        }

        if (alpha) {
          const opacity = 0.5 + influence * 0.5; // 0.5-1
          char.style.opacity = opacity.toString();
        }
      });
    };

    const animationFrame = requestAnimationFrame(updateCharacters);
    return () => cancelAnimationFrame(animationFrame);
  }, [mousePos, weight, width, italic, alpha]);

  // Split text into characters
  const characters = text.split("");

  return (
    <div
      ref={containerRef}
      className={cn(
        "w-full inline-flex items-center justify-center",
        flex ? "flex-wrap" : "flex-nowrap",
        className
      )}
      style={{
        fontFamily,
        color: textColor,
        lineHeight: "1.2",
        letterSpacing: "-0.02em",
      }}
    >
      {characters.map((char, index) => (
        <span
          key={index}
          ref={(el) => {
            if (el) charsRef.current[index] = el;
          }}
          style={{
            display: "inline-block",
            position: "relative",
            WebkitTextStroke: stroke
              ? `${strokeWidth}px ${strokeColor}`
              : undefined,
            whiteSpace: char === " " ? "pre" : undefined,
            transition: "font-variation-settings 0.1s ease-out",
          } as React.CSSProperties}
        >
          {char}
        </span>
      ))}
    </div>
  );
};

export default TextPressure;
