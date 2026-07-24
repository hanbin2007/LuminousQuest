import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderBench, type BenchScene } from '../src/features/builder/bench-renderer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('builder bench renderer', () => {
  it('never sends a negative running-bubble radius to Canvas2D', () => {
    class PendingImage {
      complete = true;
      naturalWidth = 100;
      decoding = '';
      onload: (() => void) | null = null;
      src = '';
    }
    vi.stubGlobal('Image', PendingImage);

    const radii: number[] = [];
    const methods = new Map<PropertyKey, (...args: any[]) => void>();
    const context = new Proxy<Record<PropertyKey, unknown>>({}, {
      get(_target, property) {
        if (property === 'roundRect') return undefined;
        if (property === 'arc') {
          return (x: number, y: number, radius: number) => {
            radii.push(radius);
            if (![x, y, radius].every(Number.isFinite)) {
              throw new DOMException('non-finite arc argument', 'IndexSizeError');
            }
            if (radius < 0) {
              throw new DOMException('invalid radius', 'IndexSizeError');
            }
          };
        }
        const existing = methods.get(property);
        if (existing) return existing;
        const method = vi.fn();
        methods.set(property, method);
        return method;
      },
      set(target, property, value) {
        target[property] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const electrodeId = 'site-a-00000000-0000-4000-8000-000000000000';

    const scene: BenchScene = {
      components: [
        {
          instanceId: 'medium-1',
          componentId: 'ion-medium',
          x: 0,
          y: 0,
        },
        {
          instanceId: electrodeId,
          componentId: 'site-a',
          x: 80,
          y: 0,
        },
      ],
      definitionById: new Map([
        ['ion-medium', {
          id: 'ion-medium',
          label: 'medium',
          kind: 'ion-conductor',
          functionalRole: 'ion-conductor',
          abstract: true,
          allowedRoles: [],
          saltBridge: false,
        }],
        ['site-a', {
          id: 'site-a',
          label: 'electrode',
          kind: 'electrode',
          functionalRole: 'oxidation-site',
          abstract: true,
          allowedRoles: [],
          saltBridge: false,
        }],
      ]),
      assembly: {
        connections: [],
        wireAttachments: [],
        containment: new Map([['medium-1', [electrodeId]]]),
        arrowBindings: new Map(),
      },
      selectedId: null,
      annotate: false,
      running: new Set([electrodeId]),
      width: 640,
      height: 480,
      dpr: 1,
      time: 0,
    };

    expect(() => {
      for (const time of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
        renderBench(context, { ...scene, time }, () => undefined);
      }
    }).not.toThrow();
    expect(radii).toHaveLength(35);
    expect(radii.every((radius) => radius > 0)).toBe(true);
  });
});
