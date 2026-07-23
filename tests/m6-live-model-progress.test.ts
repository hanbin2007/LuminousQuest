import { describe, expect, it } from 'vitest';

import type { StudentSession } from '../shared/session';
import { latestAgentFocus } from '../src/features/model/agent-focus';
import { buildDimensionProgress, type LiveCellState } from '../src/features/model/live-cell';

function stateWithLights(lights: Array<[string, LiveCellState['nodes'][number]['dimensionId'], string]>) {
  return {
    nodes: lights.map(([id, dimensionId, light]) => ({
      id,
      dimensionId,
      statement: id,
      position: { x: 0, y: 0, z: 0 },
      light,
      ignitionIndex: null,
    })),
  } as LiveCellState;
}

describe('buildDimensionProgress', () => {
  it('derives per-dimension ratio with half-lit at half weight', () => {
    const state = stateWithLights([
      ['D1', 'device', 'full-lit'],
      ['D2', 'device', 'half-lit'],
      ['D3', 'device', 'dark'],
      ['P1', 'principle', 'full-lit'],
      ['P2', 'principle', 'full-lit'],
      ['E1', 'energy', 'unassessed'],
    ]);
    const [device, principle, energy] = buildDimensionProgress(state);
    expect(device).toMatchObject({ litCount: 1, halfCount: 1, totalCount: 3, complete: false });
    expect(device.ratio).toBeCloseTo(0.5);
    expect(principle).toMatchObject({ litCount: 2, totalCount: 2, complete: true, ratio: 1 });
    expect(energy).toMatchObject({ litCount: 0, totalCount: 1, complete: false, ratio: 0 });
  });

  it('never reports complete for an empty dimension', () => {
    const [device] = buildDimensionProgress(stateWithLights([['P9', 'principle', 'full-lit']]));
    expect(device).toMatchObject({ totalCount: 0, ratio: 0, complete: false });
  });

  it('is judgment-derived only: needs-review does not fill progress', () => {
    const [device] = buildDimensionProgress(stateWithLights([['D1', 'device', 'needs-review']]));
    expect(device.ratio).toBe(0);
  });
});

describe('latestAgentFocus', () => {
  const turn = (sequence: number, actions: Array<Record<string, unknown>>) => ({
    kind: 'agent.turn.completed',
    sequence,
    orderedActions: actions,
  });
  const asSession = (events: unknown[]) => ({ events }) as unknown as StudentSession;

  it('returns the focus hint from the latest turn, last action wins within a turn', () => {
    const session = asSession([
      turn(3, [{ name: 'focus_node', arguments: { nodeId: 'D1' } }]),
      turn(7, [
        { name: 'get_profile', arguments: {} },
        { name: 'focus_node', arguments: { nodeId: 'D3' } },
        { name: 'focus_node', arguments: { nodeId: 'P1' } },
      ]),
    ]);
    expect(latestAgentFocus(session)).toEqual({ nodeId: 'P1', sequence: 7 });
  });

  it('ignores turns without focus actions and non-agent events', () => {
    const session = asSession([
      { kind: 'assessment.completed', sequence: 5 },
      turn(6, [{ name: 'ask_student', arguments: { text: '想想 O₂ 去哪了?' } }]),
    ]);
    expect(latestAgentFocus(session)).toBeNull();
  });

  it('keeps a focus hint from an earlier turn when later turns add none', () => {
    const session = asSession([
      turn(2, [{ name: 'focus_node', arguments: { nodeId: 'D5' } }]),
      turn(9, [{ name: 'ask_student', arguments: { text: '继续' } }]),
    ]);
    expect(latestAgentFocus(session)).toEqual({ nodeId: 'D5', sequence: 2 });
  });
});
