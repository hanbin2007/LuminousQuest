import type {
  FunctionalRole,
  PretestConfig,
} from '../config/schemas';

export type BuilderConnectionKind = 'electron-path' | 'ion-path';
export const topologyEngineVersion = 'builder-topology.v1';
export type BuilderCarrier = 'electron' | 'cation' | 'anion';
export type TopologyOutcome = 'hit' | 'partial' | 'miss';

export interface BuilderGraphComponent {
  instanceId: string;
  componentId: string;
  label?: string;
  assignedRole?: FunctionalRole;
}

export interface BuilderGraphConnection {
  id: string;
  from: string;
  to: string;
  kind: BuilderConnectionKind;
  carrier?: BuilderCarrier;
}

export interface BuilderGraph {
  components: BuilderGraphComponent[];
  connections: BuilderGraphConnection[];
}

export interface TopologyEvidence {
  ruleId: string;
  message: string;
  componentInstanceIds: string[];
  connectionIds: string[];
}

export interface TopologyCheck {
  status: TopologyOutcome;
  ruleId: string;
  evidence: TopologyEvidence[];
}

export interface TopologyNodeDecision {
  nodeId: string;
  status: TopologyOutcome;
  evidence: TopologyEvidence[];
}

export interface BuilderTopologyAssessment {
  overall: TopologyOutcome;
  checks: {
    fourElements: TopologyCheck;
    closedCircuit: TopologyCheck;
    directionConsistency: TopologyCheck;
    abstraction: TopologyCheck;
  };
  nodeDecisions: TopologyNodeDecision[];
}

type BuilderConfig = PretestConfig['builder'];

const outcomeRank: Record<TopologyOutcome, number> = {
  hit: 0,
  partial: 1,
  miss: 2,
};

function worstOutcome(...outcomes: TopologyOutcome[]): TopologyOutcome {
  return outcomes.reduce((worst, outcome) =>
    outcomeRank[outcome] > outcomeRank[worst] ? outcome : worst, 'hit');
}

function sorted(values: Iterable<string>) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function validateGraph(graph: BuilderGraph, config: BuilderConfig) {
  const configuredIds = new Set(config.components.map((component) => component.id));
  const instanceIds = new Set<string>();
  for (const component of graph.components) {
    if (instanceIds.has(component.instanceId)) {
      throw new Error(`Duplicate builder instance ${component.instanceId}`);
    }
    if (!configuredIds.has(component.componentId)) {
      throw new Error(`Unknown builder component ${component.componentId}`);
    }
    instanceIds.add(component.instanceId);
  }

  const connectionIds = new Set<string>();
  for (const connection of graph.connections) {
    if (connectionIds.has(connection.id)) {
      throw new Error(`Duplicate builder connection ${connection.id}`);
    }
    connectionIds.add(connection.id);
    for (const endpoint of [connection.from, connection.to]) {
      if (!instanceIds.has(endpoint)) {
        throw new Error(`Builder connection ${connection.id} references missing instance ${endpoint}`);
      }
    }
    if (connection.carrier === 'electron' && connection.kind !== 'electron-path') {
      throw new Error(`Electron carrier ${connection.id} must use electron-path`);
    }
    if (
      (connection.carrier === 'cation' || connection.carrier === 'anion')
      && connection.kind !== 'ion-path'
    ) {
      throw new Error(`Ion carrier ${connection.id} must use ion-path`);
    }
  }
}

function buildRoleIndex(graph: BuilderGraph, config: BuilderConfig) {
  const configured = new Map(config.components.map((component) => [component.id, component]));
  const roles = new Map<FunctionalRole, string[]>();
  for (const role of config.assessment.generalModel.requiredRoles) roles.set(role, []);
  const roleByInstance = new Map<string, FunctionalRole>();

  for (const instance of graph.components) {
    const role = instance.assignedRole ?? configured.get(instance.componentId)?.functionalRole;
    if (!role) continue;
    roleByInstance.set(instance.instanceId, role);
    const instances = roles.get(role)!;
    instances.push(instance.instanceId);
    roles.set(role, instances);
  }
  for (const instances of roles.values()) instances.sort((left, right) => left.localeCompare(right));
  return { configured, roles, roleByInstance };
}

function roleOutcome(instances: readonly string[]): TopologyOutcome {
  if (instances.length === 0) return 'miss';
  if (instances.length > 1) return 'partial';
  return 'hit';
}

function pathExists(
  starts: readonly string[],
  targets: ReadonlySet<string>,
  requiredIntermediate: ReadonlySet<string>,
  connections: readonly BuilderGraphConnection[],
  directed: boolean,
) {
  if (starts.length === 0 || targets.size === 0 || requiredIntermediate.size === 0) return false;
  const adjacency = new Map<string, string[]>();
  const addEdge = (from: string, to: string) => {
    const next = adjacency.get(from) ?? [];
    next.push(to);
    adjacency.set(from, next);
  };
  for (const connection of connections) {
    addEdge(connection.from, connection.to);
    if (!directed) addEdge(connection.to, connection.from);
  }

  const queue = starts.map((instanceId) => ({ instanceId, usedIntermediate: false }));
  const visited = new Set(queue.map(({ instanceId, usedIntermediate }) => `${instanceId}\0${usedIntermediate}`));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (targets.has(current.instanceId) && current.usedIntermediate) return true;
    for (const next of adjacency.get(current.instanceId) ?? []) {
      const usedIntermediate = current.usedIntermediate || requiredIntermediate.has(next);
      const key = `${next}\0${usedIntermediate}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ instanceId: next, usedIntermediate });
    }
  }
  return false;
}

function evidence(
  ruleId: string,
  message: string,
  componentInstanceIds: Iterable<string>,
  connectionIds: Iterable<string> = [],
): TopologyEvidence {
  return {
    ruleId,
    message,
    componentInstanceIds: sorted(componentInstanceIds),
    connectionIds: sorted(connectionIds),
  };
}

function labelContainsConcreteMaterial(label: string, concreteLabels: readonly string[]) {
  return concreteLabels.some((candidate) => {
    if (/^[A-Za-z]+$/.test(candidate)) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^A-Za-z])${escaped}($|[^A-Za-z])`, 'i').test(label);
    }
    return label.includes(candidate);
  });
}

export function assessBuilderTopology(
  graph: BuilderGraph,
  config: BuilderConfig,
): BuilderTopologyAssessment {
  validateGraph(graph, config);
  const { configured, roles, roleByInstance } = buildRoleIndex(graph, config);
  const requiredRoles = config.assessment.generalModel.requiredRoles;
  const roleStatuses = new Map(
    requiredRoles.map((role) => [role, roleOutcome(roles.get(role)!)]),
  );
  const allRoleInstances = requiredRoles.flatMap((role) => roles.get(role)!);
  const fourElementsStatus = worstOutcome(...requiredRoles.map((role) => roleStatuses.get(role)!));
  const fourElementsRule = config.structuralRules.find((rule) => rule.check === 'four-elements')!;
  const fourElements: TopologyCheck = {
    status: fourElementsStatus,
    ruleId: fourElementsRule.id,
    evidence: requiredRoles.map((role) => {
      const instances = roles.get(role)!;
      const message = instances.length === 0
        ? `Missing functional role ${role}`
        : instances.length === 1
          ? `Functional role ${role} is represented once`
          : `Functional role ${role} is ambiguous (${instances.length} instances)`;
      return evidence(fourElementsRule.id, message, instances);
    }),
  };

  const oxidation = roles.get('oxidation-site')!;
  const reduction = new Set(roles.get('reduction-site')!);
  const electronConductors = new Set(roles.get('electron-conductor')!);
  const ionConductors = new Set(roles.get('ion-conductor')!);
  const electronConnections = graph.connections.filter((edge) => edge.kind === 'electron-path');
  const ionConnections = graph.connections.filter((edge) => edge.kind === 'ion-path');
  const electronConnected = pathExists(
    oxidation,
    reduction,
    electronConductors,
    electronConnections,
    false,
  );
  const ionConnected = pathExists(oxidation, reduction, ionConductors, ionConnections, false);
  const circuitRule = config.structuralRules.find((rule) => rule.check === 'closed-circuit')!;
  const closedCircuit: TopologyCheck = {
    status: electronConnected && ionConnected ? 'hit' : 'miss',
    ruleId: circuitRule.id,
    evidence: [
      evidence(
        circuitRule.id,
        electronConnected ? 'Electron path connects both reaction sites' : 'Electron path is open',
        [...oxidation, ...reduction, ...electronConductors],
        electronConnections.map((edge) => edge.id),
      ),
      evidence(
        circuitRule.id,
        ionConnected ? 'Ion path connects both reaction sites' : 'Ion path is open',
        [...oxidation, ...reduction, ...ionConductors],
        ionConnections.map((edge) => edge.id),
      ),
    ],
  };

  const markedElectronConnections = electronConnections.filter((edge) => edge.carrier === 'electron');
  const electronDirectionCorrect = pathExists(
    oxidation,
    reduction,
    electronConductors,
    markedElectronConnections,
    true,
  );
  const cationConnections = ionConnections.filter((edge) => edge.carrier === 'cation');
  const anionConnections = ionConnections.filter((edge) => edge.carrier === 'anion');
  const cationCorrect = cationConnections.length > 0 && cationConnections.every(
    (edge) => roleByInstance.get(edge.to) === config.assessment.direction.cationToward,
  );
  const anionCorrect = anionConnections.length > 0 && anionConnections.every(
    (edge) => roleByInstance.get(edge.to) === config.assessment.direction.anionToward,
  );
  const hasAllDirectionMarkers = markedElectronConnections.length > 0
    && cationConnections.length > 0
    && anionConnections.length > 0;
  const directionStatus: TopologyOutcome = !hasAllDirectionMarkers
    ? 'partial'
    : electronDirectionCorrect && cationCorrect && anionCorrect
      ? 'hit'
      : 'miss';
  const directionRule = config.structuralRules.find((rule) => rule.check === 'direction-consistency')!;
  const directionConsistency: TopologyCheck = {
    status: directionStatus,
    ruleId: directionRule.id,
    evidence: [
      evidence(
        directionRule.id,
        electronDirectionCorrect
          ? 'Electron arrows run from oxidation site to reduction site'
          : 'Electron arrows do not run from oxidation site to reduction site',
        [...oxidation, ...reduction, ...electronConductors],
        markedElectronConnections.map((edge) => edge.id),
      ),
      evidence(
        directionRule.id,
        cationCorrect ? 'Cation arrow targets the reduction site' : 'Cation arrow is missing or reversed',
        cationConnections.flatMap((edge) => [edge.from, edge.to]),
        cationConnections.map((edge) => edge.id),
      ),
      evidence(
        directionRule.id,
        anionCorrect ? 'Anion arrow targets the oxidation site' : 'Anion arrow is missing or reversed',
        anionConnections.flatMap((edge) => [edge.from, edge.to]),
        anionConnections.map((edge) => edge.id),
      ),
    ],
  };

  const concreteInstances = graph.components.filter((instance) => {
    const component = configured.get(instance.componentId)!;
    return !component.abstract || (
      instance.label !== undefined
      && labelContainsConcreteMaterial(
        instance.label,
        config.assessment.abstraction.concreteLabels,
      )
    );
  });
  const abstractionRule = config.structuralRules.find((rule) => rule.check === 'abstraction')!;
  const abstractionStatus: TopologyOutcome = concreteInstances.length === 0
    ? 'hit'
    : config.assessment.abstraction.concreteBindingOutcome;
  const abstraction: TopologyCheck = {
    status: abstractionStatus,
    ruleId: abstractionRule.id,
    evidence: [
      evidence(
        abstractionRule.id,
        concreteInstances.length === 0
          ? 'Model uses functional, material-independent components'
          : config.assessment.abstraction.feedback,
        concreteInstances.map((instance) => instance.instanceId),
      ),
    ],
  };

  const decisions: Array<[string, TopologyOutcome, TopologyEvidence[]]> = [
    [
      'D1',
      roleStatuses.get('oxidation-site')!,
      fourElements.evidence.filter((item) => item.message.includes('oxidation-site')),
    ],
    [
      'D2',
      worstOutcome(roleStatuses.get('electron-conductor')!, electronConnected ? 'hit' : 'miss'),
      [fourElements.evidence.find((item) => item.message.includes('electron-conductor'))!, closedCircuit.evidence[0]],
    ],
    [
      'D3',
      worstOutcome(roleStatuses.get('ion-conductor')!, ionConnected ? 'hit' : 'miss'),
      [fourElements.evidence.find((item) => item.message.includes('ion-conductor'))!, closedCircuit.evidence[1]],
    ],
    [
      'D4',
      roleStatuses.get('reduction-site')!,
      fourElements.evidence.filter((item) => item.message.includes('reduction-site')),
    ],
    ['D5', abstraction.status, abstraction.evidence],
    ['P4', directionConsistency.status, directionConsistency.evidence],
  ];

  return {
    overall: worstOutcome(
      fourElements.status,
      closedCircuit.status,
      directionConsistency.status,
      abstraction.status,
    ),
    checks: { fourElements, closedCircuit, directionConsistency, abstraction },
    nodeDecisions: decisions.map(([nodeId, status, decisionEvidence]) => ({
      nodeId,
      status,
      evidence: decisionEvidence,
    })),
  };
}
