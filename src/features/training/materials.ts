import type { CaseConfig } from '../../../shared/config/schemas';

const mediumLabels: Record<CaseConfig['medium'], string> = {
  acidic: '酸性介质',
  alkaline: '碱性介质',
  neutral: '中性介质',
  molten: '熔融',
};

export function mediumLabel(medium: CaseConfig['medium']) {
  return mediumLabels[medium];
}

export function visibleCaseMaterials(
  trainingCase: CaseConfig,
  completedNodeIds: readonly string[],
) {
  const completed = new Set(completedNodeIds);
  return trainingCase.materials.filter((material) =>
    material.status === 'ready'
    && material.revealAfterNodeIds.every((nodeId) => completed.has(nodeId)));
}
