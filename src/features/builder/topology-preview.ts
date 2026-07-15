import type { FunctionalRole, PretestConfig } from '../../../shared/config/schemas';
import type {
  BuilderGraph,
  BuilderGraphConnection,
} from '../../../shared/scoring/topology';

type BuilderConfig = PretestConfig['builder'];

function roleIndex(graph: BuilderGraph, config: BuilderConfig) {
  const definitions = new Map(config.components.map((component) => [component.id, component]));
  return new Map(graph.components.flatMap((component) => {
    const role = component.assignedRole ?? definitions.get(component.componentId)?.functionalRole;
    return role ? [[component.instanceId, role] as const] : [];
  }));
}

function hasPathThroughRole(input: {
  graph: BuilderGraph;
  connections: BuilderGraphConnection[];
  roles: Map<string, FunctionalRole>;
  internalRole: FunctionalRole;
}) {
  const starts = [...input.roles].filter(([, role]) => role === 'oxidation-site').map(([id]) => id);
  const targets = new Set(
    [...input.roles].filter(([, role]) => role === 'reduction-site').map(([id]) => id),
  );
  const adjacency = new Map<string, string[]>();
  for (const edge of input.connections) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  const queue = starts.map((id) => ({ id, throughInternal: false }));
  const visited = new Set(queue.map(({ id }) => `${id}:false`));
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current.id) ?? []) {
      const throughInternal = current.throughInternal || input.roles.get(next) === input.internalRole;
      if (targets.has(next) && throughInternal) return true;
      if (!targets.has(next) && input.roles.get(next) !== input.internalRole) continue;
      const key = `${next}:${throughInternal}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ id: next, throughInternal });
    }
  }
  return false;
}

export function previewCircuitClosure(graph: BuilderGraph, config: BuilderConfig) {
  const roles = roleIndex(graph, config);
  return {
    electronClosed: hasPathThroughRole({
      graph,
      roles,
      connections: graph.connections.filter((connection) => connection.kind === 'electron-path'),
      internalRole: 'electron-conductor',
    }),
    ionClosed: hasPathThroughRole({
      graph,
      roles,
      connections: graph.connections.filter((connection) => connection.kind === 'ion-path'),
      internalRole: 'ion-conductor',
    }),
  };
}
