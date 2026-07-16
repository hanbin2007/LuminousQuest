import { RadarChart } from 'echarts/charts';
import { AriaComponent, GraphicComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

import type { TransferComparison } from './transfer-comparison';

echarts.use([RadarChart, TooltipComponent, AriaComponent, GraphicComponent, SVGRenderer]);

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

const levelLabels = {
  unassessed: '未测',
  weak: '薄弱',
  developing: '发展中',
  mastered: '掌握',
} as const;

function resultLabel(result: TransferComparison['dimensions'][number]['pretest']) {
  return result.ratio === null
    ? levelLabels.unassessed
    : `${percent(result.ratio)} · ${levelLabels[result.level]}`;
}

export function TransferRadarComparison({ comparison }: TransferRadarComparisonProps) {
  const container = useRef<HTMLDivElement>(null);
  const hasUnassessedPretest = comparison.dimensions.some((entry) => entry.pretest.ratio === null);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string) => styles.getPropertyValue(name).trim();
    const axisColors = {
      device: token('--dim-device'),
      principle: token('--dim-principle'),
      energy: token('--dim-energy'),
    } as const;
    let chart: ReturnType<typeof echarts.init> | null = null;

    const render = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      chart ??= echarts.init(element, undefined, { renderer: 'svg' });
      chart.resize({ width, height });
      const center = [width / 2, height * 0.52] as const;
      const radius = Math.min(width * 0.3, height * 0.29);
      const endpoints = comparison.dimensions.map((dimension, index) => {
        const angle = (-90 + index * 120) * Math.PI / 180;
        return {
          dimension,
          x: center[0] + Math.cos(angle) * radius,
          y: center[1] + Math.sin(angle) * radius,
        };
      });
      chart.setOption({
        animationDuration: Number.parseFloat(token('--dur-base')) || 0,
        aria: {
          enabled: true,
          decal: { show: false },
          description: comparison.dimensions.map((dimension) =>
            `${dimension.label}前测${resultLabel(dimension.pretest)}，后测${resultLabel(dimension.transfer)}`).join('；'),
        },
        tooltip: {
          trigger: 'item',
          backgroundColor: token('--paper-raised'),
          borderColor: token('--hairline'),
          textStyle: { color: token('--ink'), fontFamily: token('--font-body') },
        },
        radar: {
          center,
          radius,
          splitNumber: 4,
          indicator: comparison.dimensions.map((dimension) => ({ name: dimension.label, max: 100 })),
          axisLine: { show: false },
          splitLine: { lineStyle: { color: token('--hairline') } },
          splitArea: { areaStyle: { color: [token('--paper-raised'), token('--paper-sunken')] } },
          axisName: { color: token('--ink'), fontFamily: token('--font-body') },
        },
        graphic: [
          ...endpoints.map(({ dimension, x, y }) => ({
            type: 'line',
            silent: true,
            shape: { x1: center[0], y1: center[1], x2: x, y2: y },
            style: { stroke: axisColors[dimension.dimensionId], lineWidth: 2 },
          })),
          ...endpoints.flatMap(({ dimension, x, y }) =>
            dimension.pretest.ratio === null || dimension.transfer.ratio === null ? [{
              type: 'group',
              silent: true,
              children: [
                {
                  type: 'circle',
                  shape: { cx: x, cy: y, r: 6 },
                  style: {
                    fill: token('--paper-raised'),
                    stroke: token('--status-unassessed'),
                    lineWidth: 3,
                  },
                },
                {
                  type: 'text',
                  style: {
                    x,
                    y: y + 12,
                    text: '未测',
                    textAlign: 'center',
                    fill: token('--status-unassessed'),
                    font: `12px ${token('--font-body')}`,
                  },
                },
              ],
            }] : []),
        ],
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
              <dd><span>训练前</span><strong data-level={dimension.pretest.level}>{resultLabel(dimension.pretest)}</strong></dd>
              <dd><span>后测</span><strong data-level={dimension.transfer.level}>{resultLabel(dimension.transfer)}</strong></dd>
              <small>共同节点 {dimension.commonNodeIds.length} · 缺测不计分母</small>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
