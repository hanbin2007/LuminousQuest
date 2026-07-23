import type { LoadedConfig } from '../../shared/config/schemas';

export function createPublicConfigView(config: LoadedConfig) {
  const view = structuredClone(config) as LoadedConfig;
  view.cases = config.cases.map((trainingCase) => ({
    version: trainingCase.version,
    id: trainingCase.id,
    sequence: trainingCase.sequence,
    title: trainingCase.title,
    type: trainingCase.type,
    caseType: trainingCase.caseType,
    medium: trainingCase.medium,
    materials: structuredClone(trainingCase.materials),
    scaffold: trainingCase.scaffold.map((entry) => {
      const { answerPoints: _answerPoints, ...publicEntry } = entry;
      return publicEntry;
    }),
    equationSets: trainingCase.equationSets.map((entry) => ({
      id: entry.id,
      electrode: entry.electrode,
      medium: entry.medium,
    })),
    evidencePaths: trainingCase.evidencePaths.map((entry) => ({
      id: entry.id,
      nodeId: entry.nodeId,
      source: entry.source,
    })),
    tutoring: structuredClone(trainingCase.tutoring),
    targetNodeIds: [...trainingCase.targetNodeIds],
  })) as LoadedConfig['cases'];

  for (const component of view.pretest.builder.components) {
    component.allowedRoles = [
      ...(component.functionalRole ? [component.functionalRole] : []),
      ...component.allowedRoles,
    ].filter((role, index, roles) => roles.indexOf(role) === index);
    delete (component as Partial<typeof component>).functionalRole;
    delete (component as Partial<typeof component>).distractor;
  }

  for (const question of view.pretest.questions) {
    if (question.type === 'choice') {
      for (const option of question.options) {
        delete (option as Partial<typeof option>).correct;
        delete (option as Partial<typeof option>).misconceptionIds;
      }
    } else {
      delete (question as Partial<typeof question>).answerGuidance;
      delete (question as Partial<typeof question>).evidence;
      delete (question as Partial<typeof question>).referenceEquations;
    }
  }

  return view;
}
