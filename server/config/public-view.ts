import type { LoadedConfig } from '../../shared/config/schemas';

export function createPublicConfigView(config: LoadedConfig) {
  const view = structuredClone(config) as LoadedConfig;
  view.cases = [];

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
      delete (question as Partial<typeof question>).referenceEquations;
    }
  }

  return view;
}
