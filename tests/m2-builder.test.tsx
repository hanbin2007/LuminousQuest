// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import pretestJson from '../config/pretest.json';
import { pretestSchema } from '../shared/config/schemas';
import { TopologyBuilder, type BuilderAnswer } from '../src/features/builder/TopologyBuilder';
import { assembleGalvanicCell } from './helpers/assemble-cell';
import { EquationToolbar } from '../src/features/pretest/EquationToolbar';

const builderConfig = pretestSchema.parse(pretestJson).builder;
const forbiddenBuilderLeakage = /干扰|distractor|失电子场所|得电子场所|电子导体|离子导体/i;

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
  it('uses only neutral configured labels and snaps dropped components to the 24px grid', () => {
    const view = render(<TopologyBuilder config={builderConfig} onSubmit={vi.fn()} />);

    expect(screen.getByText('蔗糖水')).toBeInTheDocument();
    expect(screen.getByText('绝缘连接件')).toBeInTheDocument();
    expect(view.container.innerHTML).not.toMatch(forbiddenBuilderLeakage);
    const renderedAttributes = [...view.container.querySelectorAll('*')]
      .flatMap((element) => element.getAttributeNames().map((name) => `${name}=${element.getAttribute(name)}`))
      .join('\n');
    expect(renderedAttributes).not.toMatch(forbiddenBuilderLeakage);

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

    const placed = screen.getByRole('button', { name: /画布组件.*导体棒 A/ });
    expect(placed.closest('.builder-node')).toHaveStyle({ left: '120px', top: '72px' });
    expect(canvas).toHaveAttribute('data-snap-flash', 'true');
    expect(view.container.innerHTML).not.toMatch(forbiddenBuilderLeakage);

    const moveTransfer = dataTransfer('');
    fireEvent.dragStart(placed.closest('.builder-node')!, { dataTransfer: moveTransfer });
    const move = createEvent.drop(canvas);
    Object.defineProperties(move, {
      clientX: { value: 392 },
      clientY: { value: 302 },
      dataTransfer: { value: moveTransfer },
    });
    fireEvent(canvas, move);
    expect(placed.closest('.builder-node')).toHaveStyle({ left: '384px', top: '216px' });
  });

  it('assembles a physical cell (dip + auto-clip + annotation layer) and scores hit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TopologyBuilder config={builderConfig} onSubmit={onSubmit} />);

    await assembleGalvanicCell(user);

    expect(screen.getByText('电子路径已闭合')).toBeInTheDocument();
    expect(screen.getByText('离子路径已闭合')).toBeInTheDocument();
    expect(screen.getByText(/可导电液体或离子通道:导体棒 A、导体棒 B/)).toBeInTheDocument();
    expect(screen.getByText(/金属连接件:导体棒 A ↔ 导体棒 B/)).toBeInTheDocument();
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

  it('shows raw path connectivity without validating whether a chosen material is effective', () => {
    const value = {
      components: [
        // 蔗糖水池 (240,96):液面 265..400 × 179..351;两电极底端入液
        { instanceId: 'sugar', componentId: 'sucrose-solution', x: 240, y: 96 },
        { instanceId: 'a', componentId: 'site-a', x: 288, y: 48 },
        { instanceId: 'b', componentId: 'site-b', x: 336, y: 48 },
      ],
      connections: [],
    } satisfies BuilderAnswer;

    render(<TopologyBuilder config={builderConfig} initialValue={value} onSubmit={vi.fn()} />);

    expect(screen.getByText('离子路径已闭合')).toBeInTheDocument();
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

    expect(screen.queryByRole('button', { name: /画布组件.*导体棒 A/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /画布组件.*导体棒 B/ })).toBeInTheDocument();
  });

  it('skips an unknown restored component definition instead of crashing render', () => {
    const value = {
      components: [{ instanceId: 'legacy', componentId: 'removed-component', x: 24, y: 24 }],
      connections: [],
    } satisfies BuilderAnswer;

    expect(() => render(
      <TopologyBuilder config={builderConfig} initialValue={value} onSubmit={vi.fn()} />,
    )).not.toThrow();
    expect(screen.queryByRole('button', { name: /画布组件/ })).not.toBeInTheDocument();
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
