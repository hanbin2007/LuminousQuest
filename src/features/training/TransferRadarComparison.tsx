import { RadarChart } from 'echarts/charts';
import { AriaComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

import type { TransferComparison } from './transfer-comparison';

echarts.use([RadarChart, TooltipComponent, AriaComponent, SVGRenderer]);

interface TransferRadarComparisonProps {
  comparison: TransferComparison;
}

function seriesValues(
  dimensions: TransferComparison['dimensions'],
  phase: 'pretest' | 'transfer',
) {
  return dimensions.map((dimension) => {
    const ratio = dimension[phase].ratio;
    return ratio === null ? '-' as const : Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  });
}

function percent(value: number | null) {
  return value === null ? '未测' : `${Math.round(value * 100)}%`;
}

export function TransferRadarComparison({ comparison }: TransferRadarComparisonProps) {
  const container = useRef<HTMLDivElement>(null);
  const hasUnassessedPretest = comparison.dimensions.some((entry) => entry.pretest.ratio === null);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string) => styles.getPropertyValue(name).trim();
    let chart: ReturnType<typeof echarts.init> | null = null;

    const render = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      chart ??= echarts.init(element, undefined, { renderer: 'svg' });
      chart.resize({ width, height });
      chart.setOption({
        animationDuration: Number.parseFloat(token('--dur-base')) || 0,
        aria: {
          enabled: true,
          decal: { show: false },
          description: comparison.dimensions.map((dimension) =>
            `${dimension.label}前测${percent(dimension.pretest.ratio)}，后测${percent(dimension.transfer.ratio)}`).join('；'),
        },
        tooltip: {
          trigger: 'item',
          backgroundColor: token('--paper-raised'),
          borderColor: token('--hairline'),
          textStyle: { color: token('--ink'), fontFamily: token('--font-body') },
        },
        radar: {
          center: ['50%', '52%'],
          radius: '58%',
          splitNumber: 4,
          indicator: comparison.dimensions.map((dimension) => ({ name: dimension.label, max: 100 })),
          axisLine: { lineStyle: { color: token('--hairline') } },
          splitLine: { lineStyle: { color: token('--hairline') } },
          splitArea: { areaStyle: { color: [token('--paper-raised'), token('--paper-sunken')] } },
          axisName: { color: token('--ink'), fontFamily: token('--font-body') },
        },
        series: [{
          type: 'radar',
          data: [
            {
              name: '训练前',
              value: seriesValues(comparison.dimensions, 'pretest'),
              lineStyle: { color: token('--ink-soft'), width: 1 },
              itemStyle: { color: token('--ink-soft') },
              areaStyle: { color: token('--ink-soft'), opacity: 0.4 },
            },
            {
              name: '冷迁移后测',
              value: seriesValues(comparison.dimensions, 'transfer'),
              lineStyle: { color: token('--ink'), width: 3 },
              itemStyle: { color: token('--ink') },
              areaStyle: { opacity: 0 },
            },
          ],
        }],
      }, true);
    };

    render();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(render) : null;
    observer?.observe(element);
    window.addEventListener('resize', render);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', render);
      chart?.dispose();
    };
  }, [comparison]);

  return (
    <section className="transfer-comparison" aria-labelledby="transfer-comparison-title">
      <header>
        <span>共同节点归一化</span>
        <h2 id="transfer-comparison-title">训练前后对比</h2>
        {hasUnassessedPretest ? <p className="transfer-comparison__notice">前测未测</p> : null}
      </header>
      <div className="transfer-comparison__layout">
        <div
          ref={container}
          className="transfer-comparison__radar"
          role="img"
          aria-label="训练前与冷迁移后测三维度雷达对比"
        />
        <dl className="transfer-comparison__scores">
          {comparison.dimensions.map((dimension) => (
            <div key={dimension.dimensionId} data-dimension={dimension.dimensionId}>
              <dt>{dimension.label}</dt>
              <dd><span>训练前</span><strong>{percent(dimension.pretest.ratio)}</strong></dd>
              <dd><span>后测</span><strong>{percent(dimension.transfer.ratio)}</strong></dd>
              <small>共同节点 {dimension.commonNodeIds.length} · 缺测不计分母</small>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
