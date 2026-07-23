import type { LoadedConfig } from '../../shared/config/schemas';

export const appStages = [
  { id: 'pretest', path: '/pretest', label: '前测' },
  { id: 'training', path: '/training', label: '训练' },
  { id: 'model', path: '/model', label: '外显' },
] as const;

export type AppStageId = typeof appStages[number]['id'];

export function pretestStepPath(config: LoadedConfig, step: number) {
  if (step <= 0) return '/pretest/builder';
  if (step <= config.pretest.questions.length) {
    return `/pretest/question/${encodeURIComponent(config.pretest.questions[step - 1]!.id)}`;
  }
  if (step === config.pretest.questions.length + 1) return '/pretest/drawing';
  return '/pretest/diagnosis';
}

export function resolvePretestStep(config: LoadedConfig, pathname: string) {
  const normalized = pathname.replace(/\/+$/, '');
  if (normalized === '/pretest' || normalized === '/pretest/builder') return 0;
  if (normalized === '/pretest/drawing') return config.pretest.questions.length + 1;
  if (normalized === '/pretest/diagnosis') return config.pretest.questions.length + 2;
  const match = normalized.match(/^\/pretest\/question\/([^/]+)$/);
  if (!match) return null;
  const questionId = decodeURIComponent(match[1]!);
  const index = config.pretest.questions.findIndex((question) => question.id === questionId);
  return index < 0 ? null : index + 1;
}

export function trainingCasePath(caseId: string) {
  return `/training/${encodeURIComponent(caseId)}`;
}

export function resolveTrainingCaseId(config: LoadedConfig, pathname: string) {
  const match = pathname.replace(/\/+$/, '').match(/^\/training\/([^/]+)$/);
  if (!match) return null;
  const caseId = decodeURIComponent(match[1]!);
  return config.cases.some((entry) => entry.id === caseId) ? caseId : null;
}

export function routeContextLabel(config: LoadedConfig, pathname: string) {
  if (pathname.startsWith('/training')) {
    const caseId = resolveTrainingCaseId(config, pathname);
    return config.cases.find((entry) => entry.id === caseId)?.title
      ?? config.cases.find((entry) => entry.sequence === 1)?.title
      ?? '案例训练';
  }
  if (pathname.startsWith('/model')) return '认知模型';
  if (pathname.startsWith('/teacher')) return '教师视图';
  if (pathname.startsWith('/glass-lab')) return '玻璃材质实验室';
  return '前测诊断';
}

export function routeDocumentTitle(config: LoadedConfig, pathname: string) {
  return `${routeContextLabel(config, pathname)} · LuminousQuest`;
}
