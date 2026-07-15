// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import pretestJson from '../config/pretest.json';
import { pretestSchema } from '../shared/config/schemas';
import { TopologyBuilder, type BuilderAnswer } from '../src/features/builder/TopologyBuilder';
import { EquationToolbar } from '../src/features/pretest/EquationToolbar';

const builderConfig = pretestSchema.parse(pretestJson).builder;

afterEach(cleanup);

function dataTransfer(componentId: string) {
  const values = new Map<string, string>([['application/x-lq-component', componentId]]);
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

describe('M2 topology builder', () => {
  it('offers configured distractors and snaps dropped components to the 24px grid', () => {
    render(<TopologyBuilder config={builderConfig} onSubmit={vi.fn()} />);

    expect(screen.getByText('蔗糖水')).toBeInTheDocument();
    expect(screen.getByText('绝缘连接件')).toBeInTheDocument();

    const canvas = screen.getByTestId('builder-canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 720,
      bottom: 480,
      width: 720,
      height: 480,
      toJSON: () => ({}),
    });
    const drop = createEvent.drop(canvas);
    Object.defineProperties(drop, {
      clientX: { value: 133 },
      clientY: { value: 167 },
      dataTransfer: { value: dataTransfer('site-a') },
    });
    fireEvent(canvas, drop);

    const placed = screen.getByRole('button', { name: /画布组件.*失电子场所/ });
    expect(placed.closest('.builder-node')).toHaveStyle({ left: '72px', top: '96px' });
    expect(canvas).toHaveAttribute('data-snap-flash', 'true');

    const moveTransfer = dataTransfer('');
    fireEvent.dragStart(placed.closest('.builder-node')!, { dataTransfer: moveTransfer });
    const move = createEvent.drop(canvas);
    Object.defineProperties(move, {
      clientX: { value: 392 },
      clientY: { value: 302 },
      dataTransfer: { value: moveTransfer },
    });
    fireEvent(canvas, move);
    expect(placed.closest('.builder-node')).toHaveStyle({ left: '336px', top: '240px' });
  });

  it('connects both carrier paths and submits through the existing topology assessor', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TopologyBuilder config={builderConfig} onSubmit={onSubmit} />);

    for (const label of [
      '失电子场所',
      '电子导体',
      '离子导体',
      '得电子场所',
      '电子方向箭头',
      '阳离子方向箭头',
      '阴离子方向箭头',
    ]) {
      await user.click(screen.getByRole('button', { name: `添加 ${label}` }));
    }

    const canvas = screen.getByTestId('builder-canvas');
    const node = (label: string) => within(canvas).getByRole('button', {
      name: new RegExp(`画布组件.*${label}`),
    });

    await user.click(screen.getByRole('button', { name: '电子路径' }));
    await user.click(node('失电子场所'));
    await user.click(node('电子导体'));
    await user.click(node('电子导体'));
    await user.click(node('得电子场所'));

    await user.click(screen.getByRole('button', { name: '离子路径' }));
    await user.selectOptions(screen.getByLabelText('方向载流粒子'), 'cation');
    await user.click(node('离子导体'));
    await user.click(node('得电子场所'));
    await user.selectOptions(screen.getByLabelText('方向载流粒子'), 'anion');
    await user.click(node('离子导体'));
    await user.click(node('失电子场所'));

    expect(screen.getByText('电子路径已闭合')).toBeInTheDocument();
    expect(screen.getByText('离子路径已闭合')).toBeInTheDocument();
    expect(screen.queryByText(/hit|partial|miss/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '提交搭建' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][1]).toMatchObject({
      overall: 'hit',
      checks: {
        closedCircuit: { status: 'hit' },
        directionConsistency: { status: 'hit' },
      },
    });
  });

  it('adopts a restored builder value when the active session changes', () => {
    const first = {
      components: [{ instanceId: 'first', componentId: 'site-a', x: 24, y: 24 }],
      connections: [],
    } satisfies BuilderAnswer;
    const restored = {
      components: [{ instanceId: 'restored', componentId: 'site-b', x: 72, y: 48 }],
      connections: [],
    } satisfies BuilderAnswer;
    const view = render(<TopologyBuilder config={builderConfig} initialValue={first} onSubmit={vi.fn()} />);

    view.rerender(<TopologyBuilder config={builderConfig} initialValue={restored} onSubmit={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /画布组件.*失电子场所/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /画布组件.*得电子场所/ })).toBeInTheDocument();
  });
});

describe('equation symbol toolbar', () => {
  it('inserts chemistry symbols at the current text selection', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = React.useState('Zn ');
      return (
        <>
          <EquationToolbar value={value} onChange={setValue} textareaId="equation-answer" />
          <textarea id="equation-answer" aria-label="方程式作答" value={value} onChange={(event) => setValue(event.target.value)} />
        </>
      );
    }

    const React = await import('react');
    render(<Harness />);
    const textarea = screen.getByLabelText('方程式作答') as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 3);
    await user.click(screen.getByRole('button', { name: '插入 e⁻' }));
    expect(textarea).toHaveValue('Zn e⁻');
  });
});
