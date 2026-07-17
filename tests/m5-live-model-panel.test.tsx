// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import type { LoadedConfig } from '../shared/config/schemas';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../shared/session';
import { LiveModelPanel } from '../src/features/training/LiveModelPanel';

function sessionWithHit(config: LoadedConfig, nodeId: string) {
  const answer = '电子从锌极流向铜极。';
  let session = createSession({
    id: 'panel-session',
    anonymousStudentId: 'anon-PANEL001',
    now: '2026-07-16T12:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  });
  session = appendSessionEvent(session, {
    id: `answer-${nodeId}`,
    occurredAt: '2026-07-16T12:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: `attempt-${nodeId}`,
    questionId: `question-${nodeId}`,
    answer: { format: 'text', value: answer },
  });
  const rubric = config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId)!;
  const decision = resolveRubricDecision({
    rubrics: config.rubrics,
    scaffoldPolicy: config.scaffoldPolicy,
    nodeId,
    objectiveOutcome: 'hit',
    assistance: { kind: 'none', rounds: 0 },
  });
  return appendSessionEvent(session, {
    id: `assessment-${nodeId}`,
    occurredAt: '2026-07-16T12:00:02.000Z',
    kind: 'assessment.completed',
    pipelineStage: 'score',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: `attempt-${nodeId}`,
    sourceAnswerEventId: `answer-${nodeId}`,
    nodeId,
    rubric: { id: rubric.id, version: config.rubrics.version },
    objectiveOutcome: 'hit',
    extraction: {
      status: 'assessed',
      evidence: [{ quote: answer, start: 0, end: answer.length }],
      model: 'fixture-v1',
      provenance: {
        promptId: 'structured-assessment',
        promptVersion: 'prompt.v1',
        cacheKey: `cache-${nodeId}`,
      },
    },
    ...decision,
  });
}

describe('live model split panel', () => {
  afterEach(cleanup);

  it('renders the textual light list when WebGL is unavailable and reflects lit nodes', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    const session = sessionWithHit(config, 'P4');

    render(
      <LiveModelPanel
        session={session}
        config={config}
        trainingCase={trainingCase}
        focusNodeId={null}
        onFocus={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', { name: '电化学统一认知模型' })).toBeInTheDocument();
    expect(screen.getByText(/当前环境不支持 3D 渲染/)).toBeInTheDocument();
    expect(screen.getByText(/已点亮 1 \//)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^P4（已掌握/ })).toHaveClass('node-chip--full-lit');
  });

  it('surfaces the focused node statement in the live region and toggles focus via chips', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    const session = sessionWithHit(config, 'P4');
    const onFocus = vi.fn();
    const user = userEvent.setup();

    const view = render(
      <LiveModelPanel
        session={session}
        config={config}
        trainingCase={trainingCase}
        focusNodeId="P4"
        onFocus={onFocus}
      />,
    );

    const statement = config.knowledgeModel.nodes.find((node) => node.id === 'P4')!.statement;
    expect(screen.getByText((text) => text.includes('聚焦 P4') && text.includes(statement.slice(0, 8))))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^P4（/ })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /^P4（/ }));
    expect(onFocus).toHaveBeenCalledWith(null);
    await user.click(screen.getByRole('button', { name: /^E1（/ }));
    expect(onFocus).toHaveBeenCalledWith('E1');

    view.rerender(
      <LiveModelPanel
        session={session}
        config={config}
        trainingCase={trainingCase}
        focusNodeId={null}
        onFocus={onFocus}
      />,
    );
    expect(screen.getByText(/提交作答或点击节点/)).toBeInTheDocument();
  });

  it('freezes into a static notice for cold-transfer cases without any light state', async () => {
    const config = await loadAllConfig(process.cwd());
    const transferCase = config.cases.find((entry) => entry.caseType === 'transfer')!;
    const session = sessionWithHit(config, 'P4');

    render(
      <LiveModelPanel
        session={session}
        config={config}
        trainingCase={transferCase}
        focusNodeId={null}
        onFocus={() => undefined}
      />,
    );

    expect(screen.getByText(/冷迁移后测不显示即时对错/)).toBeInTheDocument();
    expect(screen.queryByText(/已点亮/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^P4（/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/当前环境不支持 3D 渲染/)).not.toBeInTheDocument();
  });
});
