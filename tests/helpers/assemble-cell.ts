import { createEvent, fireEvent, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { vi } from 'vitest';

/**
 * 工作台 v2 物理装配脚本:按坐标把器材拖进池子/拖近电极,
 * 与运行时的 deriveAssembly 几何推导完全对齐(坐标注释见各步)。
 */

export function makeDataTransfer(entries: Array<[string, string]> = []) {
  const values = new Map<string, string>(entries);
  return {
    effectAllowed: 'copy',
    dropEffect: 'copy',
    files: [],
    items: [],
    types: [...values.keys()],
    clearData: () => values.clear(),
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => values.set(type, value),
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
}

export function mockBuilderCanvas() {
  const canvas = screen.getByTestId('builder-canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 640, width: 1200, height: 640,
    toJSON: () => ({}),
  } as DOMRect);
  return canvas;
}

export function dropNewComponent(canvas: HTMLElement, componentId: string, clientX: number, clientY: number) {
  const drop = createEvent.drop(canvas);
  Object.defineProperties(drop, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    dataTransfer: { value: makeDataTransfer([['application/x-lq-component', componentId]]) },
  });
  fireEvent(canvas, drop);
}

export function canvasNode(canvas: HTMLElement, label: string) {
  return within(canvas).getByRole('button', { name: new RegExp(`画布组件.*${label}`) });
}

/** 搭出一个判分应为 hit 的锌铜式原电池(含三向方向标注)。 */
export async function assembleGalvanicCell(user: UserEvent) {
  const canvas = mockBuilderCanvas();

  dropNewComponent(canvas, 'ion-medium', 360, 300); // 池 → (264,168),液面 289..449 × 251..423
  dropNewComponent(canvas, 'site-a', 340, 260);     // 电极 A → (312,168),底端 (330,329) 入液
  dropNewComponent(canvas, 'site-b', 420, 260);     // 电极 B → (408,168),底端 (426,329) 入液
  dropNewComponent(canvas, 'electron-link', 380, 150); // 导线 → 中心 (387,155),两夹咬合 A/B 顶端

  const node = (label: string) => canvasNode(canvas, label);
  await user.click(node('导体棒 A'));
  await user.selectOptions(screen.getByLabelText('导体棒 A 的功能角色'), 'oxidation-site');
  await user.click(node('导体棒 B'));
  await user.selectOptions(screen.getByLabelText('导体棒 B 的功能角色'), 'reduction-site');
  await user.click(node('可导电液体或离子通道'));
  await user.selectOptions(screen.getByLabelText('可导电液体或离子通道 的功能角色'), 'ion-conductor');
  await user.click(node('金属连接件'));
  await user.selectOptions(screen.getByLabelText('金属连接件 的功能角色'), 'electron-conductor');
  await user.keyboard('{Escape}');

  await user.click(screen.getByRole('button', { name: '标注方向' }));
  dropNewComponent(canvas, 'electron-arrow', 380, 120); // 绑定导线,默认向右 = A→B(氧化→还原)
  dropNewComponent(canvas, 'cation-arrow', 360, 300);   // 池内,向右 = 指向还原极 B
  dropNewComponent(canvas, 'anion-arrow', 380, 340);    // 池内,需翻转指向氧化极 A
  await user.click(node('阴离子方向箭头'));
  await user.click(screen.getByRole('button', { name: '翻转 阴离子方向箭头' }));
  await user.keyboard('{Escape}');

  return canvas;
}
