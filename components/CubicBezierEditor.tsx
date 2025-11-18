'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface CubicBezierEditorProps {
  value: [number, number, number, number];
  onChange: (value: [number, number, number, number]) => void;
  onCommit?: (value: [number, number, number, number]) => void;
  disabled?: boolean;
}

export const CubicBezierEditor = memo(CubicBezierEditorComponent);

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const DEFAULT_SIZE = 320;
const DEBUG_BEZIER = process.env.NODE_ENV !== 'production';

type Palette = {
  background: string;
  border: string;
  muted: string;
  primary: string;
};

const rad = (degrees: number) => (degrees * Math.PI) / 180;

const parseHue = (value: string) => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.endsWith('deg')) {
    return parseFloat(trimmed.replace('deg', ''));
  }
  if (trimmed.endsWith('grad')) {
    return parseFloat(trimmed.replace('grad', '')) * 0.9;
  }
  if (trimmed.endsWith('turn')) {
    return parseFloat(trimmed.replace('turn', '')) * 360;
  }
  if (trimmed.endsWith('rad')) {
    return (parseFloat(trimmed.replace('rad', '')) * 180) / Math.PI;
  }
  return parseFloat(trimmed);
};

const parsePercentableValue = (value: string | undefined | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const isPercent = trimmed.endsWith('%');
  const numeric = parseFloat(trimmed.replace('%', ''));
  if (Number.isNaN(numeric)) return null;
  return isPercent ? numeric / 100 : numeric;
};

const linearToSrgb = (value: number) => {
  const clamped = clamp(value);
  if (clamped <= 0.0031308) return 12.92 * clamped;
  return 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
};

const oklchToRgba = (value: string): string | null => {
  const match = value.match(/^oklch\((.+)\)$/i);
  if (!match) return null;
  const [componentsPart, alphaPart] = match[1].split('/');
  if (!componentsPart) return null;
  const components = componentsPart
    .split(/\s+/)
    .map((component) => component.trim())
    .filter(Boolean);
  if (components.length < 3) return null;

  const lightness = parsePercentableValue(components[0]) ?? parseFloat(components[0]);
  const chroma = parsePercentableValue(components[1]) ?? parseFloat(components[1]);
  const hue = parseHue(components[2]);
  if (
    lightness === null ||
    Number.isNaN(lightness) ||
    chroma === null ||
    Number.isNaN(chroma) ||
    hue === null ||
    Number.isNaN(hue)
  ) {
    return null;
  }

  const angle = rad(hue);
  const a = Math.cos(angle) * chroma;
  const b = Math.sin(angle) * chroma;

  const l = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bChannel = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const to255 = (channel: number) => {
    const srgb = linearToSrgb(channel);
    return Math.round(clamp(srgb) * 255);
  };

  const alphaSource =
    typeof alphaPart === 'string'
      ? parsePercentableValue(alphaPart) ?? parseFloat(alphaPart)
      : 1;
  const alpha = clamp(
    typeof alphaSource === 'number' && !Number.isNaN(alphaSource) ? alphaSource : 1
  );

  const [sr, sg, sb] = [to255(r), to255(g), to255(bChannel)];

  if (alpha >= 1) {
    return `rgb(${sr}, ${sg}, ${sb})`;
  }
  const normalizedAlpha = Math.round(alpha * 1000) / 1000;
  return `rgba(${sr}, ${sg}, ${sb}, ${normalizedAlpha})`;
};

const debugLog = (...args: unknown[]) => {
  if (!DEBUG_BEZIER) return;
  console.log('[curve]', ...args);
};

const normalizeCssColor = (value: string, fallback: string) => {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/^(url|image|linear-gradient|radial-gradient|conic-gradient)\(/i.test(trimmed)) {
    return fallback;
  }
  if (/^oklch\(/i.test(trimmed)) {
    const converted = oklchToRgba(trimmed);
    if (converted) {
      return converted;
    }
    return fallback;
  }
  return trimmed;
};

const arePalettesEqual = (a: Palette, b: Palette) =>
  a.background === b.background &&
  a.border === b.border &&
  a.muted === b.muted &&
  a.primary === b.primary;

function CubicBezierEditorComponent({
  value,
  onChange,
  onCommit,
  disabled = false,
}: CubicBezierEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const draggingHandleRef = useRef<'p1' | 'p2' | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<'p1' | 'p2' | null>(null);
  const [palette, setPalette] = useState<Palette>({
    background: '#09090b',
    border: 'rgba(255,255,255,0.12)',
    muted: 'rgba(255,255,255,0.35)',
    primary: '#a855f7',
  });
  const paletteUpdateFrameRef = useRef<number | null>(null);
  const commitFrameRef = useRef<number | null>(null);
  const dragLogRef = useRef({ lastLog: 0, events: 0 });
  const pendingValueRef = useRef<{
    value: [number, number, number, number];
    capturedAt: number;
  } | null>(null);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const readCssColor = useCallback((token: string, fallback: string) => {
    if (typeof document === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim();
    if (!value) return fallback;
    return normalizeCssColor(value, fallback);
  }, []);

  const now = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const refreshPalette = useCallback(() => {
    const nextPalette: Palette = {
      background: readCssColor('--background', '#09090b'),
      border: readCssColor('--border', 'rgba(255,255,255,0.12)'),
      muted: readCssColor('--muted-foreground', 'rgba(255,255,255,0.35)'),
      primary: readCssColor('--primary', '#a855f7'),
    };
    setPalette((prev) => (arePalettesEqual(prev, nextPalette) ? prev : nextPalette));
  }, [readCssColor]);

  const schedulePaletteRefresh = useCallback(() => {
    if (typeof window === 'undefined') {
      refreshPalette();
      return;
    }
    if (paletteUpdateFrameRef.current !== null) return;
    paletteUpdateFrameRef.current = window.requestAnimationFrame(() => {
      paletteUpdateFrameRef.current = null;
      refreshPalette();
    });
  }, [refreshPalette]);

  useEffect(() => {
    schedulePaletteRefresh();
    if (typeof document === 'undefined') {
      return;
    }
    const hasMutationObserver = typeof MutationObserver !== 'undefined';
    const observer = hasMutationObserver
      ? new MutationObserver(() => {
          schedulePaletteRefresh();
        })
      : null;

    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const media =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const handleSchemeChange = () => schedulePaletteRefresh();
    media?.addEventListener('change', handleSchemeChange);

    return () => {
      observer?.disconnect();
      media?.removeEventListener('change', handleSchemeChange);
      if (paletteUpdateFrameRef.current !== null) {
        cancelAnimationFrame(paletteUpdateFrameRef.current);
        paletteUpdateFrameRef.current = null;
      }
    };
  }, [schedulePaletteRefresh]);

  const flushPendingChange = useCallback(() => {
    commitFrameRef.current = null;
    if (!pendingValueRef.current) return;
    const { value: nextValue, capturedAt } = pendingValueRef.current;
    const commitStartedAt = now();
    const latency = commitStartedAt - capturedAt;
    debugLog('flushing pending bezier value', nextValue, `(latency ${latency.toFixed(2)}ms)`);
    onChange(nextValue);
    const duration = now() - commitStartedAt;
    debugLog('onChange duration', `${duration.toFixed(2)}ms`);
    pendingValueRef.current = null;
  }, [onChange]);

  const scheduleCommit = useCallback(() => {
    if (commitFrameRef.current !== null) return;
    commitFrameRef.current = window.requestAnimationFrame(flushPendingChange);
  }, [flushPendingChange]);

  useEffect(() => {
    return () => {
      if (commitFrameRef.current !== null) {
        cancelAnimationFrame(commitFrameRef.current);
      }
    };
  }, []);

  const updateHandleFromClient = useCallback(
    (handle: 'p1' | 'p2', clientX: number, clientY: number) => {
      const container = editorRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const width = rect.width || DEFAULT_SIZE;
      const height = rect.height || DEFAULT_SIZE;
      const normalizedX = clamp((clientX - rect.left) / width);
      const normalizedY = clamp(1 - (clientY - rect.top) / height);
      const current = valueRef.current;
      const nextValue: [number, number, number, number] =
        handle === 'p1'
          ? [normalizedX, normalizedY, current[2], current[3]]
          : [current[0], current[1], normalizedX, normalizedY];
      pendingValueRef.current = {
        value: nextValue,
        capturedAt: now(),
      };
      valueRef.current = nextValue;
      if (DEBUG_BEZIER && typeof performance !== 'undefined') {
        const stats = dragLogRef.current;
        const now = performance.now();
      stats.events += 1;
      if (now - stats.lastLog >= 100) {
        debugLog(
          `drag samples in ${Math.round(now - stats.lastLog)}ms`,
          stats.events,
          'next',
            nextValue
          );
          stats.events = 0;
          stats.lastLog = now;
        }
      }
      scheduleCommit();
    },
    [scheduleCommit]
  );

  const startDragging = useCallback(
    (handle: 'p1' | 'p2', event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      event.preventDefault();
      draggingHandleRef.current = handle;
      setDraggingHandle(handle);
      updateHandleFromClient(handle, event.clientX, event.clientY);
    },
    [disabled, updateHandleFromClient]
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const handle = draggingHandleRef.current;
      if (!handle || disabled) return;
      event.preventDefault();
      updateHandleFromClient(handle, event.clientX, event.clientY);
    };

    const stopDragging = () => {
      if (!draggingHandleRef.current) return;
      draggingHandleRef.current = null;
      setDraggingHandle(null);
      if (onCommit) {
        onCommit(valueRef.current);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    };
  }, [disabled, onCommit, updateHandleFromClient]);

  const controlStyles = useMemo(
    () => ({
      p1: {
        left: `${(value[0] * 100).toFixed(2)}%`,
        top: `${((1 - value[1]) * 100).toFixed(2)}%`,
      },
      p2: {
        left: `${(value[2] * 100).toFixed(2)}%`,
        top: `${((1 - value[3]) * 100).toFixed(2)}%`,
      },
    }),
    [value]
  );

  const svgPoints = useMemo(
    () => ({
      start: { x: 0, y: 100 },
      end: { x: 100, y: 0 },
      c1: { x: value[0] * 100, y: (1 - value[1]) * 100 },
      c2: { x: value[2] * 100, y: (1 - value[3]) * 100 },
    }),
    [value]
  );

  const curvePath = useMemo(
    () =>
      `M${svgPoints.start.x} ${svgPoints.start.y} C ${svgPoints.c1.x} ${svgPoints.c1.y}, ${svgPoints.c2.x} ${svgPoints.c2.y}, ${svgPoints.end.x} ${svgPoints.end.y}`,
    [svgPoints]
  );

  return (
    <div className="space-y-3">
      <div className="relative w-full rounded-lg border border-border bg-muted/50 p-4">
        <div ref={editorRef} className="relative mx-auto aspect-square w-full max-w-md">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full select-none"
            aria-hidden="true"
          >
            <rect
              x="0"
              y="0"
              width="100"
              height="100"
              fill={palette.background}
              stroke={palette.border}
              strokeWidth="0.8"
              rx="2"
            />
            <g stroke={palette.border} strokeWidth="0.4" strokeOpacity="0.6">
              <line x1="0" y1="50" x2="100" y2="50" />
              <line x1="50" y1="0" x2="50" y2="100" />
            </g>
            <line
              x1="0"
              y1="100"
              x2="100"
              y2="0"
              stroke={palette.border}
              strokeWidth="0.6"
              strokeDasharray="4 4"
              strokeOpacity="0.7"
            />
            <g stroke={palette.muted} strokeWidth="0.8">
              <line x1="0" y1="100" x2={svgPoints.c1.x} y2={svgPoints.c1.y} />
              <line x1="100" y1="0" x2={svgPoints.c2.x} y2={svgPoints.c2.y} />
            </g>
            <path
              d={curvePath}
              fill="none"
              stroke={palette.primary}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <button
            type="button"
            aria-label="Adjust control point 1"
            className={`absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-background/80 bg-primary/80 shadow transition active:cursor-grabbing active:scale-95 disabled:cursor-not-allowed disabled:pointer-events-none ${
              draggingHandle === 'p1' ? 'ring-2 ring-primary/80' : ''
            }`}
            style={controlStyles.p1}
            onPointerDown={(event) => startDragging('p1', event)}
            disabled={disabled}
          />
          <button
            type="button"
            aria-label="Adjust control point 2"
            className={`absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-background/80 bg-primary/80 shadow transition active:cursor-grabbing active:scale-95 disabled:cursor-not-allowed disabled:pointer-events-none ${
              draggingHandle === 'p2' ? 'ring-2 ring-primary/80' : ''
            }`}
            style={controlStyles.p2}
            onPointerDown={(event) => startDragging('p2', event)}
            disabled={disabled}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
        <div className="space-y-0.5">
          <p className="font-medium text-foreground">Control Point 1</p>
          <p>x: {value[0].toFixed(2)}</p>
          <p>y: {value[1].toFixed(2)}</p>
        </div>
        <div className="space-y-0.5">
          <p className="font-medium text-foreground">Control Point 2</p>
          <p>x: {value[2].toFixed(2)}</p>
          <p>y: {value[3].toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
}
