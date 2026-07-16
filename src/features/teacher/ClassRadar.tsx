import { RadarChart } from 'echarts/charts';
import { AriaComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

import type { buildClassSummary } from './teacher-data';

echarts.use([RadarChart, TooltipComponent, AriaComponent, SVGRenderer]);

type ClassDimension = ReturnType<typeof buildClassSummary>['dimensions'][number];

function percent(value: number | null) {
  return value === null ? '-' as const : Math.round(value * 100);
}

export function ClassRadar({ dimensions }: { dimensions: readonly ClassDimension[] }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    let chart: ReturnType<typeof echarts.init> | null = null;

    const render = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const styles = getComputedStyle(document.documentElement);
      const token = (name: string) => styles.getPropertyValue(name).trim();
      chart ??= echarts.init(element, undefined, { renderer: 'svg' });
      chart.resize({ width, height });
      chart.setOption({
        animationDuration: 0,
        aria: {
          enabled: true,
          decal: { show: false },
          description: `班级三维雷达。${dimensions.map((item) =>
            `${item.label}均值${item.mean === null ? '未测' : `${Math.round(item.mean * 100)}分`}`).join('，')}。`,
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
          indicator: dimensions.map((item) => ({ name: item.label, max: 100 })),
          axisLine: { lineStyle: { color: token('--hairline') } },
          splitLine: { lineStyle: { color: token('--hairline') } },
          splitArea: {
            areaStyle: { color: [token('--paper-raised'), token('--paper-sunken')] },
          },
          axisName: {
            color: token('--ink'),
            fontFamily: token('--font-body'),
          },
        },
        series: [
          {
            name: '上四分位',
            type: 'radar',
            symbol: 'none',
            lineStyle: { color: token('--dim-principle'), opacity: 0.35, width: 1 },
            areaStyle: { color: token('--dim-principle'), opacity: 0.15 },
            data: [{ value: dimensions.map((item) => percent(item.quartileHigh)) }],
          },
          {
            name: '下四分位',
            type: 'radar',
            symbol: 'none',
            lineStyle: { color: token('--dim-principle'), opacity: 0.35, width: 1 },
            areaStyle: { color: token('--paper-raised'), opacity: 1 },
            data: [{ value: dimensions.map((item) => percent(item.quartileLow)) }],
          },
          {
            name: '班级均值',
            type: 'radar',
            symbol: 'circle',
            symbolSize: 6,
            lineStyle: { color: token('--ink'), width: 2 },
            itemStyle: { color: token('--ink') },
            areaStyle: { opacity: 0 },
            data: [{ value: dimensions.map((item) => percent(item.mean)) }],
          },
        ],
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
  }, [dimensions]);

  const description = dimensions.map((item) =>
    `${item.label}${item.mean === null ? '未测' : `均值 ${Math.round(item.mean * 100)} 分`}`).join('，');
  return (
    <div
      ref={container}
      className="class-radar"
      role="img"
      aria-label={`班级三维雷达：${description}`}
    />
  );
}
