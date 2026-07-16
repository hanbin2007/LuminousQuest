import type { FunctionalRole, PretestConfig } from '../../../shared/config/schemas';
import {
  configuredRoleWhitelist,
  maximumBuilderComponents,
  maximumBuilderConnections,
} from '../../../shared/scoring/topology';
import type { BuilderAnswer, PlacedBuilderComponent } from '../builder/TopologyBuilder';

export interface PretestDraft {
  step: number;
  builder: BuilderAnswer;
  answers: Record<string, string>;
}

export const pretestDraftStorageKey = (sessionId: string) =>
  `luminous-quest:pretest-ui.v1:${sessionId}`;

export function emptyPretestDraft(): PretestDraft {
  return { step: 0, builder: { components: [], connections: [] }, answers: {} };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeBuilder(value: unknown, config: PretestConfig['builder']): BuilderAnswer {
  const source = record(value);
  const definitions = new Map(config.components.map((component) => [component.id, component]));
  const instanceIds = new Set<string>();
  const components = (Array.isArray(source?.components) ? source.components : [])
    .slice(0, maximumBuilderComponents)
    .flatMap((candidate): PlacedBuilderComponent[] => {
      const component = record(candidate);
      const instanceId = typeof component?.instanceId === 'string' ? component.instanceId.trim() : '';
      const componentId = typeof component?.componentId === 'string' ? component.componentId : '';
      const definition = definitions.get(componentId);
      if (
        !definition
        || !instanceId
        || instanceIds.has(instanceId)
        || typeof component?.x !== 'number'
        || !Number.isFinite(component.x)
        || typeof component.y !== 'number'
        || !Number.isFinite(component.y)
      ) return [];
      instanceIds.add(instanceId);
      const assignedRole = typeof component.assignedRole === 'string'
        && configuredRoleWhitelist(definition).includes(component.assignedRole as FunctionalRole)
        ? component.assignedRole as FunctionalRole
        : undefined;
      const material = record(component.materialBinding);
      const materialBinding: PlacedBuilderComponent['materialBinding'] =
        typeof material?.materialId === 'string'
        && (material.specificity === 'generic' || material.specificity === 'specific')
          ? { materialId: material.materialId, specificity: material.specificity }
          : undefined;
      return [{
        instanceId,
        componentId,
        x: component.x,
        y: component.y,
        ...(typeof component.label === 'string' ? { label: component.label } : {}),
        ...(assignedRole ? { assignedRole } : {}),
        ...(materialBinding ? { materialBinding } : {}),
      }];
    });
  const connectionIds = new Set<string>();
  const connections = (Array.isArray(source?.connections) ? source.connections : [])
    .slice(0, maximumBuilderConnections)
    .flatMap((candidate): BuilderAnswer['connections'] => {
      const connection = record(candidate);
      const id = typeof connection?.id === 'string' ? connection.id.trim() : '';
      const from = typeof connection?.from === 'string' ? connection.from : '';
      const to = typeof connection?.to === 'string' ? connection.to : '';
      const kind = connection?.kind;
      const carrier = connection?.carrier;
      if (
        !id
        || connectionIds.has(id)
        || !instanceIds.has(from)
        || !instanceIds.has(to)
        || from === to
        || (kind !== 'electron-path' && kind !== 'ion-path')
        || (carrier !== undefined && !['electron', 'cation', 'anion'].includes(String(carrier)))
        || (carrier === 'electron' && kind !== 'electron-path')
        || ((carrier === 'cation' || carrier === 'anion') && kind !== 'ion-path')
      ) return [];
      connectionIds.add(id);
      return [{
        id,
        from,
        to,
        kind,
        ...(carrier ? { carrier: carrier as 'electron' | 'cation' | 'anion' } : {}),
      }];
    });
  return { components, connections };
}

export function loadPretestDraft(
  storage: Pick<Storage, 'getItem'> | null,
  sessionId: string,
  config: PretestConfig,
): PretestDraft {
  try {
    const source = storage?.getItem(pretestDraftStorageKey(sessionId));
    if (!source) return emptyPretestDraft();
    const value = record(JSON.parse(source));
    if (!value) return emptyPretestDraft();
    const maximumStep = config.questions.length + 2;
    const answers = record(value.answers);
    const questionIds = new Set(config.questions.map((question) => question.id));
    return {
      step: typeof value.step === 'number' && Number.isInteger(value.step)
        ? Math.max(0, Math.min(maximumStep, value.step))
        : 0,
      builder: sanitizeBuilder(value.builder, config.builder),
      answers: Object.fromEntries(Object.entries(answers ?? {}).filter(
        (entry): entry is [string, string] => questionIds.has(entry[0]) && typeof entry[1] === 'string',
      )),
    };
  } catch {
    return emptyPretestDraft();
  }
}

export function savePretestDraft(
  storage: Pick<Storage, 'setItem'> | null,
  sessionId: string,
  draft: PretestDraft,
) {
  storage?.setItem(pretestDraftStorageKey(sessionId), JSON.stringify(draft));
}
