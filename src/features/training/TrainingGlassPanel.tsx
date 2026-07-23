import type { ComponentProps, CSSProperties } from 'react';

import { GlassCard } from '../../components/ui/glasscn/glass-card';
import { cn } from '../../lib/utils';

type TrainingGlassPanelProps = Omit<
  ComponentProps<typeof GlassCard>,
  'glassVariant' | 'liquidProps'
>;

const trainingGlassParameters = {
  bezel: 0.28,
  blur: 1.5,
  refraction: 10,
  saturation: 1.18,
} as const;

const trainingGlassSurface = {
  '--liquid-glass-rim-dark': 'rgba(18, 18, 24, 0.12)',
  '--liquid-glass-rim-fade': '22%',
  '--liquid-glass-rim-light': 'rgba(255, 255, 255, 0.22)',
  '--liquid-glass-rim-width': '0.4px',
  backgroundColor: 'rgba(255, 255, 255, 0.055)',
} as CSSProperties;

export function TrainingGlassPanel({
  className,
  surfaceClassName,
  ...props
}: TrainingGlassPanelProps) {
  return (
    <GlassCard
      {...props}
      className={cn('!gap-0 !overflow-visible !rounded-none !py-0', className)}
      glassVariant="liquid-refract"
      liquidProps={{
        ...trainingGlassParameters,
        style: trainingGlassSurface,
      }}
      surfaceClassName={cn('training-glass-panel !rounded-none', surfaceClassName)}
    />
  );
}
