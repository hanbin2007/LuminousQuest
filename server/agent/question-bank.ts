import { createHash } from 'node:crypto';

import type { LoadedConfig } from '../../shared/config/schemas';
import {
  buildResponseContractCandidates,
  responseContractIdFor,
  type ResponseContractCandidate,
} from './response-contracts';

export type AgentQuestionBankEntry = {
  questionId: string;
  caseId: string;
  kind: 'builder' | 'choice' | 'text' | 'analysis' | 'equation';
  prompt: string;
  contentHash: `sha256:${string}`;
  targetNodeIds: string[];
  responseContractCandidateId?: string;
  assessmentFocus: string[];
};

export function hashQuestionContent(prompt: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
}

function configuredEntries(config: LoadedConfig): AgentQuestionBankEntry[] {
  const focusForNodes = (nodeIds: readonly string[]) => {
    const selected = new Set(nodeIds);
    return config.knowledgeModel.nodes
      .filter((node) => selected.has(node.id))
      .flatMap((node) => [
        `${node.id}: ${node.statement}`,
        ...node.misconceptions.map(
          (misconception) => `${node.id} 常见误区: ${misconception.statement}`,
        ),
      ]);
  };
  const pretest: AgentQuestionBankEntry[] = [
    {
      questionId: 'pretest-builder',
      caseId: 'pretest',
      kind: 'builder',
      prompt: config.pretest.builder.prompt,
      contentHash: hashQuestionContent(config.pretest.builder.prompt),
      targetNodeIds: [...new Set(
        config.pretest.builder.structuralRules.flatMap((rule) => rule.nodeIds),
      )],
      assessmentFocus: focusForNodes([
        ...new Set(
          config.pretest.builder.structuralRules.flatMap((rule) => rule.nodeIds),
        ),
      ]),
    },
    ...config.pretest.questions.map((question): AgentQuestionBankEntry => ({
      questionId: question.id,
      caseId: 'pretest',
      kind: question.type,
      prompt: question.prompt,
      contentHash: hashQuestionContent(question.prompt),
      targetNodeIds: [...question.targetNodeIds],
      assessmentFocus: focusForNodes(question.targetNodeIds),
    })),
  ];
  const cases = config.cases.flatMap((trainingCase): AgentQuestionBankEntry[] => [
    {
      questionId: `${trainingCase.id}:analysis`,
      caseId: trainingCase.id,
      kind: 'analysis',
      prompt: `请分析案例“${trainingCase.title}”中的关键电化学过程。`,
      contentHash: hashQuestionContent(
        `请分析案例“${trainingCase.title}”中的关键电化学过程。`,
      ),
      targetNodeIds: [...trainingCase.targetNodeIds],
      assessmentFocus: [
        ...focusForNodes(trainingCase.targetNodeIds),
        ...trainingCase.evidencePaths.map((entry) =>
          `${entry.nodeId} 考查点: ${entry.description}`),
      ],
    },
    ...trainingCase.equationSets.map((equationSet): AgentQuestionBankEntry => {
      const electrodeLabel = equationSet.electrode === 'negative'
        ? '负极半反应'
        : equationSet.electrode === 'positive'
          ? '正极半反应'
          : '总反应';
      const prompt = `请写出案例“${trainingCase.title}”的${electrodeLabel}方程式。`;
      return {
        questionId: `${trainingCase.id}:${equationSet.id}`,
        caseId: trainingCase.id,
        kind: 'equation',
        prompt,
        contentHash: hashQuestionContent(prompt),
        targetNodeIds: [...new Set(
          trainingCase.evidencePaths
            .filter((entry) => entry.source === 'equation')
            .map((entry) => entry.nodeId),
        )],
        assessmentFocus: [
          `${electrodeLabel}的配平、守恒与介质条件`,
          ...focusForNodes([
            ...new Set(
              trainingCase.evidencePaths
                .filter((entry) => entry.source === 'equation')
                .map((entry) => entry.nodeId),
            ),
          ]),
        ],
      };
    }),
  ]);
  return [...pretest, ...cases];
}

export function buildAgentQuestionBankIndex(input: {
  config: LoadedConfig;
  currentCaseId: string;
  agentTurnId: string;
}) {
  const candidates = buildResponseContractCandidates({
    config: input.config,
    caseId: input.currentCaseId,
    agentTurnId: input.agentTurnId,
  });
  const candidateByQuestion = new Map(
    candidates
      .filter((candidate) => candidate.kind === 'question')
      .map((candidate) => [candidate.questionId, candidate]),
  );
  return {
    entries: configuredEntries(input.config).map((entry) => ({
      ...entry,
      ...(candidateByQuestion.get(entry.questionId)
        ? {
            responseContractCandidateId:
              candidateByQuestion.get(entry.questionId)!.candidateId,
          }
        : {}),
    })),
    responseContractCandidates: candidates,
  };
}

export function findAgentQuestion(
  config: LoadedConfig,
  questionId: string,
) {
  return configuredEntries(config).find((entry) => entry.questionId === questionId);
}

export function findResponseContractCandidate(
  candidates: readonly ResponseContractCandidate[],
  identifier: string,
  input: { agentTurnId: string; callId: string },
) {
  return candidates.find((candidate) =>
    candidate.candidateId === identifier
    || identifier === responseContractIdFor(
      input.agentTurnId,
      input.callId,
      candidate.candidateId,
    ));
}
