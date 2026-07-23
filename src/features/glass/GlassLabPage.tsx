import { Check, ChevronLeft, SkipForward } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { GlassButton } from '../../components/ui/glasscn/glass-button';
import { GlassCard } from '../../components/ui/glasscn/glass-card';
import { GlassInput } from '../../components/ui/glasscn/glass-input';
import type { FrostGlassVariant } from '../../lib/glass-variants';

const glassVariants: Array<{
  id: FrostGlassVariant;
  code: string;
  name: string;
  detail: string;
}> = [
  { id: 'clear', code: 'A', name: 'Clear', detail: '2px blur · 25% white' },
  { id: 'frosted', code: 'B', name: 'Frosted', detail: '16px blur · 55% white' },
  { id: 'subtle', code: 'C', name: 'Subtle', detail: '4px blur · 30% white' },
  { id: 'liquid', code: 'D', name: 'Liquid', detail: '12px blur · layered sheen' },
  { id: 'liquid-refract', code: 'E', name: 'Liquid Refract', detail: 'SVG refraction · Chromium' },
];

export default function GlassLabPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = (searchParams.get('variant') ?? 'frosted') as FrostGlassVariant;

  return (
    <main className="glass-lab">
      <header className="glass-lab__header">
        <div>
          <span>GLASSCN · OFFICIAL COMPONENTS</span>
          <h1>毛玻璃方案预览</h1>
        </div>
        <output aria-live="polite">
          当前使用 {glassVariants.find((variant) => variant.id === selectedId)?.name ?? 'Frosted'}
        </output>
      </header>

      <section className="glass-lab__grid" aria-label="glasscn 官方毛玻璃方案">
        {glassVariants.map((variant) => {
          const selected = selectedId === variant.id;
          return (
            <article className="glass-lab__option" data-selected={selected || undefined} key={variant.id}>
              <header>
                <span>{variant.code}</span>
                <div>
                  <h2>{variant.name}</h2>
                  <small>{variant.detail}</small>
                </div>
                <GlassButton
                  aria-label={`选择方案 ${variant.code} ${variant.name}`}
                  aria-pressed={selected}
                  glassVariant={variant.id}
                  onClick={() => setSearchParams({ variant: variant.id })}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {selected ? <Check aria-hidden="true" data-icon="inline-start" /> : '选择'}
                </GlassButton>
              </header>

              <GlassCard
                className="glass-lab__specimen"
                glassVariant={variant.id}
                surfaceClassName="glass-lab__refract-surface"
              >
                <div className="glass-lab__meta">
                  <strong>03 / 04</strong>
                  <span>填空题 · 原理维度</span>
                </div>
                <h3>消耗 K 与消耗 O₂ 的物质的量之比为______。</h3>
                <label>
                  <span>K : O₂</span>
                  <GlassInput
                    aria-label={`${variant.name}答案示例`}
                    glassVariant={variant.id}
                    placeholder="例如 1:1"
                    readOnly
                  />
                </label>
                <footer>
                  <GlassButton
                    aria-label="上一题示例"
                    glassVariant={variant.id}
                    size="icon"
                    type="button"
                    variant="outline"
                  >
                    <ChevronLeft aria-hidden="true" />
                  </GlassButton>
                  <GlassButton glassVariant={variant.id} type="button" variant="outline">
                    <SkipForward aria-hidden="true" data-icon="inline-start" />
                    跳过
                  </GlassButton>
                  <GlassButton glassVariant={variant.id} type="button">下一题</GlassButton>
                </footer>
              </GlassCard>
            </article>
          );
        })}
      </section>
    </main>
  );
}
