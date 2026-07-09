import * as React from 'react';

import { cn } from '@/lib/utils';

type RangeSliderProps = Omit<React.ComponentProps<'input'>, 'type'>;

/**
 * Themed native range input. The global input[type='range'] styles paint the
 * track as a gradient — bright primary left of the thumb, dim to the right —
 * split at --slider-fill, which this wrapper derives from value/min/max.
 */
function RangeSlider({ className, style, ...props }: RangeSliderProps) {
  const min = Number(props.min ?? 0);
  const max = Number(props.max ?? 100);
  const value = Number(props.value ?? min);
  const range = max - min;
  const fill = range > 0 ? ((value - min) / range) * 100 : 0;

  return (
    <input
      type="range"
      {...props}
      style={
        {
          ...style,
          '--slider-fill': `${Math.min(Math.max(fill, 0), 100)}%`,
        } as React.CSSProperties
      }
      className={cn(className)}
    />
  );
}

export { RangeSlider };
