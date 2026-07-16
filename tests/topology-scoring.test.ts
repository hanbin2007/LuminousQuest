import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  assessBuilderTopology,
  type BuilderGraph,
} from '../shared/scoring/topology';

function completeGraph(): BuilderGraph {
  return {
    components: [
      { instanceId: 'negative', componentId: 'site-a', assignedRole: 'oxidation-site' },
      { instanceId: 'wire', componentId: 'electron-link', assignedRole: 'electron-conductor' },
      { instanceId: 'ions', componentId: 'ion-medium', assignedRole: 'ion-conductor' },
      { instanceId: 'positive', componentId: 'site-b', assignedRole: 'reduction-site' },
      { instanceId: 'electron-arrow', componentId: 'electron-arrow' },
      { instanceId: 'cation-arrow', componentId: 'cation-arrow' },
      { instanceId: 'anion-arrow', componentId: 'anion-arrow' },
    ],
    connections: [
      { id: 'e1', from: 'negative', to: 'wire', kind: 'electron-path', carrier: 'electron' },
      { id: 'e2', from: 'wire', to: 'positive', kind: 'electron-path', carrier: 'electron' },
      { id: 'i1', from: 'ions', to: 'positive', kind: 'ion-path', carrier: 'cation' },
      { id: 'i2', from: 'ions', to: 'negative', kind: 'ion-path', carrier: 'anion' },
    ],
  };
}

async function builderConfig() {
  return (await loadAllConfig(process.cwd())).pretest.builder;
}

describe('builder topology scoring', () => {
  it('accepts the four functional roles, both connected paths, all directions, and an abstract model', async () => {
    const result = assessBuilderTopology(completeGraph(), await builderConfig());

    expect(result.overall).toBe('hit');
    expect(result.checks).toMatchObject({
      fourElements: { status: 'hit' },
      closedCircuit: { status: 'hit' },
      directionConsistency: { status: 'hit' },
      abstraction: { status: 'hit' },
    });
    expect(new Set(result.nodeDecisions.map((decision) => decision.nodeId))).toEqual(
      new Set(['D1', 'D2', 'D3', 'D4', 'D5', 'P4']),
    );
    expect(result.nodeDecisions.every((decision) => decision.evidence.length > 0)).toBe(true);
  });

  it('treats every unassigned role as unassigned instead of filling answers from config', async () => {
    const graph = completeGraph();
    graph.components = graph.components.map((component) => {
      const { assignedRole: _assignedRole, ...unassigned } = component;
      return unassigned;
    });

    const result = assessBuilderTopology(graph, await builderConfig());

    expect(result.checks.fourElements.status).toBe('miss');
    expect(result.overall).toBe('miss');
    expect(result.checks.fourElements.evidence.map((entry) => entry.message).join(' '))
      .toContain('未指认');
  });

  it('traces a missing ion conductor to D3 and the closed circuit', async () => {
    const graph = completeGraph();
    graph.components = graph.components.filter((component) => component.instanceId !== 'ions');
    graph.connections = graph.connections.filter(
      (connection) => connection.from !== 'ions' && connection.to !== 'ions',
    );

    const result = assessBuilderTopology(graph, await builderConfig());

    expect(result.overall).toBe('miss');
    expect(result.checks.fourElements.status).toBe('miss');
    expect(result.checks.closedCircuit.status).toBe('miss');
    expect(result.nodeDecisions.find((decision) => decision.nodeId === 'D3')).toMatchObject({
      status: 'miss',
      evidence: expect.arrayContaining([
        expect.objectContaining({ ruleId: 'four-functional-elements' }),
      ]),
    });
  });

  it('keeps connectivity but rejects reversed electron and ion directions', async () => {
    const electronReversed = completeGraph();
    electronReversed.connections = electronReversed.connections.map((connection) =>
      connection.carrier === 'electron'
        ? { ...connection, from: connection.to, to: connection.from }
        : connection,
    );
    const ionsReversed = completeGraph();
    ionsReversed.connections = ionsReversed.connections.map((connection) => {
      if (connection.carrier === 'cation') return { ...connection, to: 'negative' };
      if (connection.carrier === 'anion') return { ...connection, to: 'positive' };
      return connection;
    });

    const electronResult = assessBuilderTopology(electronReversed, await builderConfig());
    const ionResult = assessBuilderTopology(ionsReversed, await builderConfig());

    expect(electronResult.checks.closedCircuit.status).toBe('hit');
    expect(electronResult.checks.directionConsistency.status).toBe('miss');
    expect(ionResult.checks.closedCircuit.status).toBe('hit');
    expect(ionResult.checks.directionConsistency.status).toBe('miss');
    expect(electronResult.nodeDecisions.find((decision) => decision.nodeId === 'P4')?.status).toBe('miss');
  });

  it('caps an otherwise correct concrete Zn/Cu instance at partial', async () => {
    const graph = completeGraph();
    graph.components = graph.components.map((component) => {
      if (component.instanceId === 'negative') {
        return { ...component, materialBinding: { materialId: 'Zn', specificity: 'specific' as const } };
      }
      if (component.instanceId === 'positive') {
        return { ...component, materialBinding: { materialId: 'Cu', specificity: 'specific' as const } };
      }
      return component;
    });

    const result = assessBuilderTopology(graph, await builderConfig());

    expect(result.overall).toBe('partial');
    expect(result.checks.abstraction.status).toBe('partial');
    expect(result.nodeDecisions.find((decision) => decision.nodeId === 'D5')?.status).toBe('partial');
  });

  it('uses structured material bindings instead of presentation labels', async () => {
    const graph = completeGraph();
    graph.components = graph.components.map((component) =>
      component.instanceId === 'negative'
        ? {
            ...component,
            label: '通用负极',
            materialBinding: { materialId: '锌', specificity: 'specific' as const },
          }
        : component,
    );

    expect(assessBuilderTopology(graph, await builderConfig()).checks.abstraction.status)
      .toBe('partial');
  });

  it('allows non-functional layout components without assigning a knowledge role', async () => {
    const graph = completeGraph();
    graph.components.push({ instanceId: 'beaker', componentId: 'container' });

    expect(assessBuilderTopology(graph, await builderConfig()).overall).toBe('hit');
  });

  it('accepts multiple instances of one role when they form one connected functional network', async () => {
    const graph = completeGraph();
    graph.components.push({
      instanceId: 'wire-2',
      componentId: 'electron-link',
      assignedRole: 'electron-conductor',
    });
    graph.connections = graph.connections.flatMap((connection) =>
      connection.id === 'e2'
        ? [
            { ...connection, id: 'e2a', to: 'wire-2' },
            { ...connection, id: 'e2b', from: 'wire-2' },
          ]
        : [connection],
    );

    const result = assessBuilderTopology(graph, await builderConfig());

    expect(result.overall).toBe('hit');
    expect(result.checks.fourElements.status).toBe('hit');
  });

  it('rejects role declarations outside each component whitelist', async () => {
    const graph = completeGraph();
    const config = await builderConfig();
    graph.components.push({
      instanceId: 'fake-ion-medium',
      componentId: 'sucrose-solution',
      assignedRole: 'oxidation-site',
    });

    expect(() => assessBuilderTopology(graph, config)).toThrow(/role.*not allowed/i);
  });

  it('returns one closed-loop witness using the same site pair and rejects split components', async () => {
    const valid = assessBuilderTopology(completeGraph(), await builderConfig());
    expect(valid.checks.closedCircuit).toMatchObject({
      status: 'hit',
      witness: {
        oxidationSiteId: 'negative',
        reductionSiteId: 'positive',
        electronConnectionIds: ['e1', 'e2'],
        ionConnectionIds: ['i1', 'i2'],
      },
    });

    const split = completeGraph();
    split.components.push(
      { instanceId: 'negative-2', componentId: 'site-a' },
      { instanceId: 'positive-2', componentId: 'site-b' },
    );
    split.connections = split.connections.map((connection) => {
      if (connection.kind !== 'ion-path') return connection;
      return {
        ...connection,
        to: connection.to === 'negative' ? 'negative-2' : 'positive-2',
      };
    });

    expect(assessBuilderTopology(split, await builderConfig()).checks.closedCircuit.status).toBe('miss');
  });

  it('rejects self-loop edges before they can masquerade as a circuit witness', async () => {
    const graph = completeGraph();
    const config = await builderConfig();
    graph.connections.push({
      id: 'self-loop',
      from: 'negative',
      to: 'negative',
      kind: 'electron-path',
    });

    expect(() => assessBuilderTopology(graph, config)).toThrow(/self-loop/i);
  });

  it('distinguishes missing direction markers from explicit contradictions', async () => {
    const missing = completeGraph();
    missing.connections = missing.connections.map((connection) => {
      const { carrier: _carrier, ...withoutCarrier } = connection;
      return withoutCarrier;
    });
    const contradictory = completeGraph();
    contradictory.connections = contradictory.connections.map((connection) =>
      connection.carrier === 'electron'
        ? { ...connection, from: connection.to, to: connection.from }
        : connection);

    expect(assessBuilderTopology(missing, await builderConfig()).checks.directionConsistency.status)
      .toBe('partial');
    expect(assessBuilderTopology(contradictory, await builderConfig()).checks.directionConsistency.status)
      .toBe('miss');
  });

  it('consumes required component ids and all structural assessment switches', async () => {
    const config = await builderConfig();
    const requiredChanged = structuredClone(config);
    requiredChanged.structuralRules.find((rule) => rule.check === 'closed-circuit')!
      .requiredComponentIds.push('container');
    expect(assessBuilderTopology(completeGraph(), requiredChanged).checks.closedCircuit.status).toBe('miss');

    const saltBridgeChanged = structuredClone(config);
    saltBridgeChanged.assessment.generalModel.saltBridgeRequired = true;
    expect(assessBuilderTopology(completeGraph(), saltBridgeChanged).checks.closedCircuit.status).toBe('miss');

    const openElectron = completeGraph();
    openElectron.connections = openElectron.connections.filter((connection) =>
      connection.kind !== 'electron-path');
    const electronOptional = structuredClone(config);
    electronOptional.assessment.generalModel.requireClosedElectronPath = false;
    expect(assessBuilderTopology(openElectron, electronOptional).checks.closedCircuit.status).toBe('hit');

    const reversed = completeGraph();
    reversed.connections = reversed.connections.map((connection) => {
      if (connection.carrier === 'electron') return { ...connection, from: connection.to, to: connection.from };
      if (connection.carrier === 'cation') return { ...connection, to: 'negative' };
      if (connection.carrier === 'anion') return { ...connection, to: 'positive' };
      return connection;
    });
    const directionChanged = structuredClone(config);
    directionChanged.assessment.direction = {
      electronFrom: 'reduction-site',
      electronTo: 'oxidation-site',
      cationToward: 'oxidation-site',
      anionToward: 'reduction-site',
    };
    expect(assessBuilderTopology(reversed, directionChanged).checks.directionConsistency.status).toBe('hit');
  });

  it('maps a placed distractor through its own configured misconception ids', async () => {
    const graph = completeGraph();
    graph.components = graph.components.filter((component) => component.instanceId !== 'ions');
    graph.connections = graph.connections.filter((connection) => connection.kind !== 'ion-path');
    graph.components.push({ instanceId: 'sugar', componentId: 'sucrose-solution' });

    const d3 = assessBuilderTopology(graph, await builderConfig()).nodeDecisions
      .find((decision) => decision.nodeId === 'D3');
    expect(d3?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ misconceptionIds: ['D3-M2'] }),
    ]));
  });

  it('is invariant under array order and graph identifier renaming', async () => {
    const graph = completeGraph();
    const renamed: BuilderGraph = {
      components: [...graph.components].reverse().map((component, index) => ({
        ...component,
        instanceId: `renamed-${index}-${component.instanceId}`,
      })),
      connections: [],
    };
    const renamedIds = new Map(
      renamed.components.map((component) => {
        const original = component.instanceId.slice(component.instanceId.lastIndexOf('-') + 1);
        return [original, component.instanceId];
      }),
    );
    renamed.connections = [...graph.connections].reverse().map((connection, index) => ({
      ...connection,
      id: `edge-${index}`,
      from: renamedIds.get(connection.from)!,
      to: renamedIds.get(connection.to)!,
    }));

    const config = await builderConfig();
    const originalResult = assessBuilderTopology(graph, config);
    const renamedResult = assessBuilderTopology(renamed, config);

    expect(renamedResult.overall).toBe(originalResult.overall);
    expect(
      Object.fromEntries(Object.entries(renamedResult.checks).map(([key, value]) => [key, value.status])),
    ).toEqual(
      Object.fromEntries(Object.entries(originalResult.checks).map(([key, value]) => [key, value.status])),
    );
    expect(renamedResult.nodeDecisions.map(({ nodeId, status }) => ({ nodeId, status }))).toEqual(
      originalResult.nodeDecisions.map(({ nodeId, status }) => ({ nodeId, status })),
    );
  });

  it('never returns hit after removing any required functional role', async () => {
    const config = await builderConfig();
    for (const instanceId of ['negative', 'wire', 'ions', 'positive']) {
      const graph = completeGraph();
      graph.components = graph.components.filter((component) => component.instanceId !== instanceId);
      graph.connections = graph.connections.filter(
        (connection) => connection.from !== instanceId && connection.to !== instanceId,
      );

      expect(assessBuilderTopology(graph, config).overall).not.toBe('hit');
    }
  });

  it('rejects dangling connections with traceable input errors', async () => {
    const graph = completeGraph();
    graph.connections.push({
      id: 'dangling',
      from: 'missing-instance',
      to: 'positive',
      kind: 'electron-path',
      carrier: 'electron',
    });

    const config = await builderConfig();
    expect(() => assessBuilderTopology(graph, config)).toThrow(/missing-instance/);
  });

  it('rejects duplicate or unknown graph components and duplicate connections', async () => {
    const config = await builderConfig();
    const duplicateInstance = completeGraph();
    duplicateInstance.components.push({ instanceId: 'negative', componentId: 'site-b' });
    expect(() => assessBuilderTopology(duplicateInstance, config)).toThrow(/Duplicate builder instance/);

    const unknownComponent = completeGraph();
    unknownComponent.components[0] = { instanceId: 'negative', componentId: 'unknown-component' };
    expect(() => assessBuilderTopology(unknownComponent, config)).toThrow(/Unknown builder component/);

    const duplicateConnection = completeGraph();
    duplicateConnection.connections.push({
      id: 'e1',
      from: 'negative',
      to: 'positive',
      kind: 'electron-path',
      carrier: 'electron',
    });
    expect(() => assessBuilderTopology(duplicateConnection, config)).toThrow(/Duplicate builder connection/);
  });

  it('rejects carrier labels placed on the wrong path kind', async () => {
    const config = await builderConfig();
    const electronOnIonPath = completeGraph();
    electronOnIonPath.connections[0] = {
      ...electronOnIonPath.connections[0],
      kind: 'ion-path',
    };
    expect(() => assessBuilderTopology(electronOnIonPath, config)).toThrow(/must use electron-path/);

    for (const carrier of ['cation', 'anion'] as const) {
      const ionOnElectronPath = completeGraph();
      ionOnElectronPath.connections[2] = {
        ...ionOnElectronPath.connections[2],
        kind: 'electron-path',
        carrier,
      };
      expect(() => assessBuilderTopology(ionOnElectronPath, config)).toThrow(/must use ion-path/);
    }
  });

  it('rejects oversized graphs before traversing them', async () => {
    const graph: BuilderGraph = {
      components: Array.from({ length: 65 }, (_, index) => ({
        instanceId: `container-${index}`,
        componentId: 'container',
      })),
      connections: [],
    };

    const config = await builderConfig();
    expect(() => assessBuilderTopology(graph, config)).toThrow(/64/);

    const connectionHeavy: BuilderGraph = {
      components: [
        { instanceId: 'left', componentId: 'site-a', assignedRole: 'oxidation-site' },
        { instanceId: 'right', componentId: 'site-b', assignedRole: 'reduction-site' },
      ],
      connections: Array.from({ length: 129 }, (_, index) => ({
        id: `connection-${index}`,
        from: 'left',
        to: 'right',
        kind: 'electron-path' as const,
      })),
    };
    expect(() => assessBuilderTopology(connectionHeavy, config)).toThrow(/128/);
  });
});
