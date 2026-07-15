import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { MockProvider } from '../server/llm/providers/mock';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMRequest } from '../server/llm/types';
import {
  recordStructuredTextAssessment,
  structuredAssessmentResponseJsonSchema,
} from '../shared/workflows/assessment';
import { LocalSessionStore, createSession } from '../shared/session';
import { createTemporaryDirectory } from './helpers/content-fixture';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe('zinc-copper M1a vertical slice', () => {
  it('runs answer -> score -> evidence -> radar -> save -> restore -> offline replay', async () => {
    const config = await loadAllConfig(process.cwd());
    const root = await createTemporaryDirectory();
    const answer =
      '锌是负极，铜是正极。电子由锌极经导线流向铜极；盐桥阴离子移向锌侧，阳离子移向铜侧。Zn 被氧化，Cu^2+ 被还原。化学能直接转化为电能。';
    const quoted = (quote: string) => ({
      quote,
      start: answer.indexOf(quote),
      end: answer.indexOf(quote) + quote.length,
    });
    const extracted = {
      assessments: [
        {
          nodeId: 'P2',
          logicalOutcome: 'hit',
          objectiveOutcome: 'hit',
          evidence: [quoted('Zn 被氧化，Cu^2+ 被还原。')],
          assistance: 'none',
        },
        {
          nodeId: 'P4',
          logicalOutcome: 'hit',
          objectiveOutcome: 'hit',
          evidence: [quoted('电子由锌极经导线流向铜极；盐桥阴离子移向锌侧，阳离子移向铜侧。')],
          assistance: 'none',
        },
        {
          nodeId: 'E1',
          logicalOutcome: 'hit',
          objectiveOutcome: 'hit',
          evidence: [quoted('化学能直接转化为电能。')],
          assistance: 'none',
        },
      ],
    };
    const request: LLMRequest = {
      executionMode: 'development',
      capability: 'structured',
      provider: 'mock',
      model: 'mock-v1',
      prompt: {
        id: 'zinc-copper-assessment',
        version: 'prompt.v1',
        text: 'Extract rubric outcomes and exact evidence spans.',
      },
      schemaVersion: 'structured-assessment.v1',
      configVersion: config.rubrics.version,
      input: { answer, mockStructuredResponse: extracted },
      images: [],
      schema: structuredAssessmentResponseJsonSchema,
    };
    const recordings = new RecordingStore(root);
    const online = new LLMService({
      providers: new Map([['mock', new MockProvider()]]),
      recordings,
    });

    const providerResult = await online.execute(request);
    expect(providerResult).toMatchObject({ source: 'provider', degraded: false });

    const initial = createSession({
      id: 'session-zinc-slice',
      anonymousStudentId: 'anon-A1B2C3D4',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: {
        knowledgeModel: config.knowledgeModel.version,
        rubrics: config.rubrics.version,
        pretest: config.pretest.version,
        scaffoldPolicy: config.scaffoldPolicy.version,
      },
    });
    const assessed = recordStructuredTextAssessment({
      session: initial,
      config,
      answer: {
        id: 'answer-zinc-1',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-1',
        questionId: 'zinc-copper-analysis',
        value: answer,
      },
      extraction: providerResult.response.structured,
      provenance: {
        promptId: request.prompt.id,
        promptVersion: request.prompt.version,
        cacheKey: providerResult.cacheKey,
        model: providerResult.response.model,
      },
      assessmentEventIdPrefix: 'zinc-score',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });

    expect(assessed.session.events).toHaveLength(4);
    expect(assessed.profile.nodes.find((node) => node.nodeId === 'P4')).toMatchObject({
      outcome: 'hit',
      earned: 2,
      trace: {
        originalAnswer: answer,
        evidence: extracted.assessments[1].evidence,
      },
    });
    expect(assessed.profile.dimensions.find((entry) => entry.dimensionId === 'principle'))
      .toMatchObject({ earned: 4, possible: 4, ratio: 1, assessedNodeIds: ['P2', 'P4'] });
    expect(assessed.profile.dimensions.find((entry) => entry.dimensionId === 'energy'))
      .toMatchObject({ earned: 2, possible: 2, ratio: 1, assessedNodeIds: ['E1'] });

    const localStore = new LocalSessionStore(new MemoryStorage());
    localStore.save(assessed.session);
    const restored = localStore.restoreLatest();
    expect(restored).toEqual(assessed.session);
    expect(restored?.events.filter((event) => event.kind === 'assessment.completed'))
      .toHaveLength(3);

    const offline = new LLMService({ providers: new Map(), recordings });
    const replay = await offline.execute(request);
    expect(replay).toMatchObject({
      source: 'development-cache',
      degraded: false,
      response: { structured: extracted },
    });
  });
});
