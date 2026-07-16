import type {
  FunctionalRole,
  PretestConfig,
} from '../config/schemas';

export type BuilderConnectionKind = 'electron-path' | 'ion-path';
export const topologyEngineVersion = 'builder-topology.v2';
export const maximumBuilderComponents = 64;
export const maximumBuilderConnections = 128;
export type BuilderCarrier = 'electron' | 'cation' | 'anion';
export type TopologyOutcome = 'hit' | 'partial' | 'miss';

export interface BuilderGraphComponent {
  instanceId: string;
  componentId: string;
  label?: string;
  assignedRole?: FunctionalRole;
  materialBinding?: {
    materialId: string;
    specificity: 'generic' | 'specific';
  };
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
  misconceptionIds?: string[];
}

export interface ClosedCircuitWitness {
  oxidationSiteId: string;
  reductionSiteId: string;
  electronComponentInstanceIds: string[];
  ionComponentInstanceIds: string[];
  electronConnectionIds: string[];
  ionConnectionIds: string[];
}

export interface TopologyCheck {
  status: TopologyOutcome;
  ruleId: string;
  evidence: TopologyEvidence[];
  witness?: ClosedCircuitWitness;
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
type ConfiguredComponent = BuilderConfig['components'][number];

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

export function configuredRoleWhitelist(component: ConfiguredComponent) {
  return [
    ...(component.functionalRole ? [component.functionalRole] : []),
    ...component.allowedRoles,
  ].filter((role, index, roles) => roles.indexOf(role) === index);
}

function validateGraph(graph: BuilderGraph, config: BuilderConfig) {
  if (graph.components.length > maximumBuilderComponents) {
    throw new Error(`搭建组件数量不能超过 ${maximumBuilderComponents}`);
  }
  if (graph.connections.length > maximumBuilderConnections) {
    throw new Error(`搭建连线数量不能超过 ${maximumBuilderConnections}`);
  }
  const configured = new Map(config.components.map((component) => [component.id, component]));
  const instanceIds = new Set<string>();
  for (const component of graph.components) {
    if (instanceIds.has(component.instanceId)) {
      throw new Error(`Duplicate builder instance ${component.instanceId}`);
    }
    const definition = configured.get(component.componentId);
    if (!definition) throw new Error(`Unknown builder component ${component.componentId}`);
    if (
      component.assignedRole
      && !configuredRoleWhitelist(definition).includes(component.assignedRole)
    ) {
      throw new Error(
        `Builder role ${component.assignedRole} is not allowed for component ${component.componentId}`,
      );
    }
    instanceIds.add(component.instanceId);
  }

  const connectionIds = new Set<string>();
  for (const connection of graph.connections) {
    if (connectionIds.has(connection.id)) {
      throw new Error(`Duplicate builder connection ${connection.id}`);
    }
    connectionIds.add(connection.id);
    if (connection.from === connection.to) {
      throw new Error(`Builder connection ${connection.id} is a self-loop`);
    }
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
  return configured;
}

function buildRoleIndex(
  graph: BuilderGraph,
  configured: ReadonlyMap<string, ConfiguredComponent>,
  requiredRoles: readonly FunctionalRole[],
) {
  const roles = new Map<FunctionalRole, string[]>();
  for (const role of requiredRoles) roles.set(role, []);
  const roleByInstance = new Map<string, FunctionalRole>();

  for (const instance of graph.components) {
    const role = instance.assignedRole;
    if (!role) continue;
    roleByInstance.set(instance.instanceId, role);
    const instances = roles.get(role) ?? [];
    instances.push(instance.instanceId);
    roles.set(role, instances);
  }
  for (const instances of roles.values()) instances.sort((left, right) => left.localeCompare(right));
  return { roles, roleByInstance };
}

interface PathWitness {
  componentInstanceIds: string[];
  connectionIds: string[];
}

export function findTopologyPath(
  start: string,
  target: string,
  connections: readonly BuilderGraphConnection[],
  options: {
    isInternal: (instanceId: string) => boolean;
    directed: boolean;
    requireInternal: boolean;
  },
): PathWitness | null {
  const adjacency = new Map<string, Array<{ next: string; connectionId: string }>>();
  const add = (from: string, next: string, connectionId: string) => {
    const entries = adjacency.get(from) ?? [];
    entries.push({ next, connectionId });
    entries.sort((left, right) =>
      left.connectionId.localeCompare(right.connectionId) || left.next.localeCompare(right.next));
    adjacency.set(from, entries);
  };
  connections.forEach((connection) => {
    add(connection.from, connection.to, connection.id);
    if (!options.directed) add(connection.to, connection.from, connection.id);
  });

  const queue: Array<{
    instanceId: string;
    components: string[];
    connections: string[];
    usedInternal: boolean;
  }> = [{ instanceId: start, components: [start], connections: [], usedInternal: false }];
  const visited = new Set([`${start}\0false`]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of adjacency.get(current.instanceId) ?? []) {
      if (edge.next !== target && !options.isInternal(edge.next)) continue;
      const usedInternal = current.usedInternal
        || (edge.next !== target && options.isInternal(edge.next));
      const visitKey = `${edge.next}\0${usedInternal}`;
      if (visited.has(visitKey)) continue;
      const components = [...current.components, edge.next];
      const connectionIds = [...current.connections, edge.connectionId];
      if (edge.next === target) {
        if (!options.requireInternal || usedInternal) {
          return { componentInstanceIds: components, connectionIds };
        }
        continue;
      }
      visited.add(visitKey);
      queue.push({ instanceId: edge.next, components, connections: connectionIds, usedInternal });
    }
  }
  return null;
}

export function previewBuilderConnectivity(graph: BuilderGraph, config: BuilderConfig) {
  const definitions = new Map(config.components.map((component) => [component.id, component]));
  const electrodes = graph.components
    .filter((component) => definitions.get(component.componentId)?.kind === 'electrode')
    .map((component) => component.instanceId);
  const hasConnection = (kind: BuilderConnectionKind) => {
    const connections = graph.connections.filter((connection) => connection.kind === kind);
    return electrodes.some((start, startIndex) => electrodes.slice(startIndex + 1).some((target) =>
      findTopologyPath(start, target, connections, {
        isInternal: () => true,
        directed: false,
        requireInternal: false,
      }) !== null));
  };
  return {
    electronClosed: hasConnection('electron-path'),
    ionClosed: hasConnection('ion-path'),
  };
}

function evidence(
  ruleId: string,
  message: string,
  componentInstanceIds: Iterable<string>,
  connectionIds: Iterable<string> = [],
  misconceptionIds?: Iterable<string>,
): TopologyEvidence {
  return {
    ruleId,
    message,
    componentInstanceIds: sorted(componentInstanceIds),
    connectionIds: sorted(connectionIds),
    ...(misconceptionIds ? { misconceptionIds: sorted(misconceptionIds) } : {}),
  };
}

function missingRequiredComponents(
  requiredComponentIds: readonly string[],
  graph: BuilderGraph,
) {
  const placed = new Set(graph.components.map((component) => component.componentId));
  return requiredComponentIds.filter((componentId) => !placed.has(componentId));
}

function findCircuitWitness(input: {
  oxidationSites: readonly string[];
  reductionSites: readonly string[];
  electronConnections: readonly BuilderGraphConnection[];
  ionConnections: readonly BuilderGraphConnection[];
  roleByInstance: ReadonlyMap<string, FunctionalRole>;
  configured: ReadonlyMap<string, ConfiguredComponent>;
  graph: BuilderGraph;
  requireElectron: boolean;
  requireIon: boolean;
  requireSaltBridge: boolean;
}) {
  for (const oxidationSiteId of input.oxidationSites) {
    for (const reductionSiteId of input.reductionSites) {
      const electron = input.requireElectron
        ? findTopologyPath(
            oxidationSiteId,
            reductionSiteId,
            input.electronConnections,
            {
              isInternal: (instanceId) => input.roleByInstance.get(instanceId) === 'electron-conductor',
              directed: false,
              requireInternal: true,
            },
          )
        : { componentInstanceIds: [oxidationSiteId, reductionSiteId], connectionIds: [] };
      if (!electron) continue;
      const ion = input.requireIon
        ? findTopologyPath(
            oxidationSiteId,
            reductionSiteId,
            input.ionConnections,
            {
              isInternal: (instanceId) => input.roleByInstance.get(instanceId) === 'ion-conductor',
              directed: false,
              requireInternal: true,
            },
          )
        : { componentInstanceIds: [oxidationSiteId, reductionSiteId], connectionIds: [] };
      if (!ion) continue;
      if (input.requireSaltBridge) {
        const ionComponents = new Set(ion.componentInstanceIds);
        const hasSaltBridge = input.graph.components.some((instance) =>
          ionComponents.has(instance.instanceId)
          && input.configured.get(instance.componentId)?.saltBridge === true);
        if (!hasSaltBridge) continue;
      }
      return {
        oxidationSiteId,
        reductionSiteId,
        electronComponentInstanceIds: sorted(electron.componentInstanceIds),
        ionComponentInstanceIds: sorted(ion.componentInstanceIds),
        electronConnectionIds: sorted(electron.connectionIds),
        ionConnectionIds: sorted(ion.connectionIds),
      } satisfies ClosedCircuitWitness;
    }
  }
  return undefined;
}

function directionTargetCorrect(
  connections: readonly BuilderGraphConnection[],
  targetRole: FunctionalRole,
  roleByInstance: ReadonlyMap<string, FunctionalRole>,
) {
  return connections.length > 0
    && connections.every((connection) => roleByInstance.get(connection.to) === targetRole);
}

export function assessBuilderTopology(
  graph: BuilderGraph,
  config: BuilderConfig,
): BuilderTopologyAssessment {
  const configured = validateGraph(graph, config);
  const requiredRoles = config.assessment.generalModel.requiredRoles;
  const { roles, roleByInstance } = buildRoleIndex(graph, configured, requiredRoles);

  const fourElementsRule = config.structuralRules.find((rule) => rule.check === 'four-elements')!;
  const fourMissing = missingRequiredComponents(fourElementsRule.requiredComponentIds, graph);

  const oxidation = roles.get('oxidation-site') ?? [];
  const reduction = roles.get('reduction-site') ?? [];
  const electronConnections = graph.connections.filter((edge) => edge.kind === 'electron-path');
  const ionConnections = graph.connections.filter((edge) => edge.kind === 'ion-path');
  const circuitRule = config.structuralRules.find((rule) => rule.check === 'closed-circuit')!;
  const circuitMissing = missingRequiredComponents(circuitRule.requiredComponentIds, graph);
  const witness = circuitMissing.length === 0
    ? findCircuitWitness({
        oxidationSites: oxidation,
        reductionSites: reduction,
        electronConnections,
        ionConnections,
        roleByInstance,
        configured,
        graph,
        requireElectron: config.assessment.generalModel.requireClosedElectronPath,
        requireIon: config.assessment.generalModel.requireClosedIonPath,
        requireSaltBridge: config.assessment.generalModel.saltBridgeRequired,
      })
    : undefined;
  const requiredComponentIds = new Set(fourElementsRule.requiredComponentIds);
  const requiredInstancesByRole = new Map(requiredRoles.map((role) => [
    role,
    (roles.get(role) ?? []).filter((instanceId) => {
      const instance = graph.components.find((component) => component.instanceId === instanceId);
      return instance !== undefined && requiredComponentIds.has(instance.componentId);
    }),
  ]));
  const witnessInstancesForRole = (role: FunctionalRole) => {
    if (!witness) return new Set<string>();
    if (role === 'electron-conductor') return new Set(witness.electronComponentInstanceIds);
    if (role === 'ion-conductor') return new Set(witness.ionComponentInstanceIds);
    return new Set([
      ...witness.electronComponentInstanceIds,
      ...witness.ionComponentInstanceIds,
    ]);
  };
  const roleStatuses = new Map(requiredRoles.map((role) => {
    const assigned = requiredInstancesByRole.get(role) ?? [];
    const connected = witnessInstancesForRole(role);
    return [role, assigned.some((instanceId) => connected.has(instanceId)) ? 'hit' : 'miss'] as const;
  }));
  const fourElements: TopologyCheck = {
    status: worstOutcome(
      ...requiredRoles.map((role) => roleStatuses.get(role)!),
      fourMissing.length > 0 ? 'miss' : 'hit',
    ),
    ruleId: fourElementsRule.id,
    evidence: [
      ...requiredRoles.map((role) => {
        const assigned = requiredInstancesByRole.get(role) ?? [];
        const connected = witnessInstancesForRole(role);
        const connectedAssignments = assigned.filter((instanceId) => connected.has(instanceId));
        return evidence(
          fourElementsRule.id,
          assigned.length === 0
            ? `未指认功能角色（${role}）`
            : connectedAssignments.length === 0
              ? `已指认功能角色但未接入对应通路（${role}）`
              : `学生指认的功能角色已接入对应通路（${role}）`,
          assigned,
        );
      }),
      ...(fourMissing.length > 0
        ? [evidence(
            fourElementsRule.id,
            `缺少必需的物理组件：${fourMissing.join(', ')}`,
            [],
          )]
        : []),
    ],
  };
  const electronConnected = !config.assessment.generalModel.requireClosedElectronPath
    || Boolean(witness?.electronConnectionIds.length);
  const ionConnected = !config.assessment.generalModel.requireClosedIonPath
    || Boolean(witness?.ionConnectionIds.length);
  const closedCircuit: TopologyCheck = {
    status: witness ? 'hit' : 'miss',
    ruleId: circuitRule.id,
    evidence: [
      evidence(
        circuitRule.id,
        electronConnected ? '电子通路已连通' : '电子通路悬空',
        witness?.electronComponentInstanceIds ?? [...oxidation, ...reduction],
        witness?.electronConnectionIds ?? [],
      ),
      evidence(
        circuitRule.id,
        ionConnected ? '离子通路已连通' : '离子通路悬空',
        witness?.ionComponentInstanceIds ?? [...oxidation, ...reduction],
        witness?.ionConnectionIds ?? [],
      ),
      ...(circuitMissing.length > 0
        ? [evidence(
            circuitRule.id,
            `Missing required components: ${circuitMissing.join(', ')}`,
            [],
          )]
        : []),
      ...(config.assessment.generalModel.saltBridgeRequired && !witness
        ? [evidence(circuitRule.id, 'Configured salt bridge is absent from the ion-path witness', [])]
        : []),
    ],
    ...(witness ? { witness } : {}),
  };

  const directionRule = config.structuralRules.find((rule) => rule.check === 'direction-consistency')!;
  const directionMissing = missingRequiredComponents(directionRule.requiredComponentIds, graph);
  const markedElectronConnections = electronConnections.filter((edge) => edge.carrier === 'electron');
  const electronStarts = roles.get(config.assessment.direction.electronFrom) ?? [];
  const electronTargets = roles.get(config.assessment.direction.electronTo) ?? [];
  const electronDirectionCorrect = electronStarts.some((start) => electronTargets.some((target) =>
    findTopologyPath(
      start,
      target,
      markedElectronConnections,
      {
        isInternal: (instanceId) => roleByInstance.get(instanceId) === 'electron-conductor',
        directed: true,
        requireInternal: true,
      },
    ) !== null));
  const cationConnections = ionConnections.filter((edge) => edge.carrier === 'cation');
  const anionConnections = ionConnections.filter((edge) => edge.carrier === 'anion');
  const cationCorrect = directionTargetCorrect(
    cationConnections,
    config.assessment.direction.cationToward,
    roleByInstance,
  );
  const anionCorrect = directionTargetCorrect(
    anionConnections,
    config.assessment.direction.anionToward,
    roleByInstance,
  );
  const hasAllDirectionMarkers = directionMissing.length === 0
    && markedElectronConnections.length > 0
    && cationConnections.length > 0
    && anionConnections.length > 0;
  const directionStatus: TopologyOutcome = !hasAllDirectionMarkers
    ? 'partial'
    : electronDirectionCorrect && cationCorrect && anionCorrect
      ? 'hit'
      : 'miss';
  const directionConsistency: TopologyCheck = {
    status: directionStatus,
    ruleId: directionRule.id,
    evidence: [
      evidence(
        directionRule.id,
        electronDirectionCorrect
          ? `Electron arrows run from ${config.assessment.direction.electronFrom} to ${config.assessment.direction.electronTo}`
          : 'Electron arrows are missing or contradict the configured direction',
        [...electronStarts, ...electronTargets],
        markedElectronConnections.map((edge) => edge.id),
      ),
      evidence(
        directionRule.id,
        cationCorrect ? 'Cation arrows target the configured role' : 'Cation arrows are missing or contradictory',
        cationConnections.flatMap((edge) => [edge.from, edge.to]),
        cationConnections.map((edge) => edge.id),
      ),
      evidence(
        directionRule.id,
        anionCorrect ? 'Anion arrows target the configured role' : 'Anion arrows are missing or contradictory',
        anionConnections.flatMap((edge) => [edge.from, edge.to]),
        anionConnections.map((edge) => edge.id),
      ),
    ],
  };

  const concreteInstances = graph.components.filter((instance) =>
    instance.materialBinding?.specificity === 'specific');
  const abstractionRule = config.structuralRules.find((rule) => rule.check === 'abstraction')!;
  const abstractionMissing = missingRequiredComponents(abstractionRule.requiredComponentIds, graph);
  const abstractionStatus: TopologyOutcome = abstractionMissing.length > 0
    ? 'miss'
    : concreteInstances.length === 0
      ? 'hit'
      : config.assessment.abstraction.concreteBindingOutcome;
  const abstraction: TopologyCheck = {
    status: abstractionStatus,
    ruleId: abstractionRule.id,
    evidence: [
      evidence(
        abstractionRule.id,
        concreteInstances.length === 0
          ? 'Model uses generic structured material bindings'
          : config.assessment.abstraction.feedback,
        concreteInstances.map((instance) => instance.instanceId),
      ),
    ],
  };

  const fourEvidenceFor = (role: FunctionalRole) =>
    fourElements.evidence.filter((item) => item.message.includes(role));
  const decisionMap = new Map<string, TopologyNodeDecision>();
  const addDecision = (
    nodeId: string,
    status: TopologyOutcome,
    decisionEvidence: TopologyEvidence[],
  ) => {
    const current = decisionMap.get(nodeId);
    decisionMap.set(nodeId, {
      nodeId,
      status: current ? worstOutcome(current.status, status) : status,
      evidence: [...(current?.evidence ?? []), ...decisionEvidence],
    });
  };
  const roleNode: Record<FunctionalRole, string> = {
    'oxidation-site': 'D1',
    'electron-conductor': 'D2',
    'ion-conductor': 'D3',
    'reduction-site': 'D4',
  };
  requiredRoles.forEach((role) => {
    const nodeId = roleNode[role];
    if (fourElementsRule.nodeIds.includes(nodeId)) {
      addDecision(nodeId, roleStatuses.get(role)!, fourEvidenceFor(role));
    }
  });
  if (circuitRule.nodeIds.includes('D2')) {
    addDecision('D2', electronConnected && witness ? 'hit' : 'miss', [closedCircuit.evidence[0]]);
  }
  if (circuitRule.nodeIds.includes('D3')) {
    addDecision('D3', ionConnected && witness ? 'hit' : 'miss', [closedCircuit.evidence[1]]);
  }
  directionRule.nodeIds.forEach((nodeId) =>
    addDecision(nodeId, directionConsistency.status, directionConsistency.evidence));
  abstractionRule.nodeIds.forEach((nodeId) =>
    addDecision(nodeId, abstraction.status, abstraction.evidence));

  graph.components.forEach((instance) => {
    const distractor = configured.get(instance.componentId)?.distractor;
    if (!distractor) return;
    const byNode = new Map<string, string[]>();
    distractor.misconceptionIds.forEach((misconceptionId) => {
      const nodeId = misconceptionId.split('-')[0];
      const ids = byNode.get(nodeId) ?? [];
      ids.push(misconceptionId);
      byNode.set(nodeId, ids);
    });
    byNode.forEach((misconceptionIds, nodeId) => {
      addDecision(nodeId, 'miss', [evidence(
        'configured-distractor',
        distractor.reason,
        [instance.instanceId],
        [],
        misconceptionIds,
      )]);
    });
  });

  return {
    overall: worstOutcome(
      fourElements.status,
      closedCircuit.status,
      directionConsistency.status,
      abstraction.status,
      ...[...decisionMap.values()].map((decision) => decision.status),
    ),
    checks: { fourElements, closedCircuit, directionConsistency, abstraction },
    nodeDecisions: [...decisionMap.values()].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId)),
  };
}
