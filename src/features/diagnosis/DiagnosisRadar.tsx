import { RadarChart } from 'echarts/charts';
import {
  AriaComponent,
  GraphicComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

echarts.use([RadarChart, TooltipComponent, AriaComponent, GraphicComponent, SVGRenderer]);

export interface RadarDimension {
  id: 'device' | 'principle' | 'energy';
  label: string;
  value: number;
}

const axisTerms: Record<RadarDimension['id'], string> = {
  device: '失电子场所 · 电子导体 · 离子导体 · 得电子场所',
  principle: '电极反应物 · 电极产物 · 电子与离子转移',
  energy: '化学能直接转化为电能',
};

interface DiagnosisRadarProps {
  dimensions: RadarDimension[];
}

export function DiagnosisRadar({ dimensions }: DiagnosisRadarProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element || element.getBoundingClientRect().width === 0) return undefined;
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string) => styles.getPropertyValue(name).trim();
    const tokenPixels = (name: string) => {
      const value = token(name);
      const amount = Number.parseFloat(value);
      if (!Number.isFinite(amount)) return undefined;
      if (value.endsWith('rem')) return amount * Number.parseFloat(styles.fontSize);
      return amount;
    };
    const tokenMilliseconds = (name: string) => {
      const value = token(name);
      const amount = Number.parseFloat(value);
      if (!Number.isFinite(amount)) return 0;
      return value.endsWith('s') && !value.endsWith('ms') ? amount * 1000 : amount;
    };
    const axisColors: Record<RadarDimension['id'], string> = {
      device: token('--dim-device'),
      principle: token('--dim-principle'),
      energy: token('--dim-energy'),
    };
    const chart = echarts.init(element, undefined, { renderer: 'svg' });

    const render = () => {
      const { width, height } = element.getBoundingClientRect();
      chart.resize({ width, height });
      const center = [width / 2, height * 0.52] as const;
      const radius = Math.min(width * 0.3, height * 0.29);
      const ordered = dimensions.map((dimension) => ({
        ...dimension,
        value: Math.round(Math.max(0, Math.min(1, dimension.value)) * 100),
      }));
      const endpoints = ordered.map((dimension, index) => {
        const angle = (-90 + index * 120) * Math.PI / 180;
        return {
          dimension,
          x: center[0] + Math.cos(angle) * radius,
          y: center[1] + Math.sin(angle) * radius,
        };
      });

      chart.setOption({
        animationDuration: tokenMilliseconds('--dur-base'),
        aria: {
          enabled: true,
          decal: { show: false },
          description: `前测诊断雷达图。${ordered.map((item) => `${item.label}${item.value}分`).join('，')}。`,
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
          startAngle: 90,
          splitNumber: 4,
          indicator: ordered.map((dimension) => ({
            name: `${dimension.label}\n${axisTerms[dimension.id]}`,
            max: 100,
          })),
          axisLine: { show: false },
          splitLine: { lineStyle: { color: token('--hairline') } },
          splitArea: {
            areaStyle: {
              color: [token('--paper-raised'), token('--paper-sunken')],
            },
          },
          axisName: {
            color: token('--ink'),
            fontFamily: token('--font-body'),
            fontSize: tokenPixels('--text-xs'),
            lineHeight: 18,
          },
        },
        graphic: endpoints.map(({ dimension, x, y }) => ({
          type: 'line',
          silent: true,
          shape: { x1: center[0], y1: center[1], x2: x, y2: y },
          style: { stroke: axisColors[dimension.id], lineWidth: 2 },
        })),
        series: [{
          name: '前测',
          type: 'radar',
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: { color: token('--ink'), width: 2 },
          itemStyle: { color: token('--ink') },
          areaStyle: { color: token('--ink'), opacity: 0.4 },
          data: [{ name: '前测', value: ordered.map((dimension) => dimension.value) }],
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
      chart.dispose();
    };
  }, [dimensions]);

  return <div ref={container} className="diagnosis-radar" role="img" aria-label="三维度前测雷达图" />;
}
