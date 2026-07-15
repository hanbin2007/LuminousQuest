import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { MockProvider } from '../server/llm/providers/mock';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMRequest } from '../server/llm/types';
import {
  recordStructuredTextAssessment,
  structuredAssessmentResponseJsonSchema,
  structuredAssessmentResponseSchema,
} from '../shared/workflows/assessment';
import { LocalSessionStore, createSession, sessionConfigVersions } from '../shared/session';
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
    config.cases.find((entry) => entry.id === 'zinc-copper')!.evidencePaths
      .find((entry) => entry.nodeId === 'P2')!.factRequirements = [
        { id: 'reducing-agent', acceptedValues: ['Zn'] },
        { id: 'oxidizing-agent', acceptedValues: ['Cu^2+'] },
      ];
    config.cases.find((entry) => entry.id === 'zinc-copper')!.evidencePaths
      .find((entry) => entry.nodeId === 'E1')!.factRequirements = [
        { id: 'energy-from', acceptedValues: ['chemical'] },
        { id: 'energy-to', acceptedValues: ['electric'] },
      ];
    const extracted = {
      anchors: [{
        anchorId: 'case-polarity',
        facts: [
          { id: 'negative', value: 'Zn' },
          { id: 'positive', value: 'Cu' },
        ],
        evidence: [quoted('锌是负极，铜是正极')],
      }],
      assessments: [
        {
          nodeId: 'P2',
          errorIds: [],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: [
              { id: 'reducing-agent', value: 'Zn' },
              { id: 'oxidizing-agent', value: 'Cu^2+' },
            ],
          },
          evidence: [quoted('Zn 被氧化，Cu^2+ 被还原。')],
          assistance: { kind: 'none', rounds: 0 },
        },
        {
          nodeId: 'P4',
          errorIds: [],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: [
              { id: 'electron-from', value: 'Zn' },
              { id: 'electron-to', value: 'Cu' },
              { id: 'anion-toward', value: 'Zn' },
              { id: 'cation-toward', value: 'Cu' },
            ],
          },
          evidence: [quoted('电子由锌极经导线流向铜极；盐桥阴离子移向锌侧，阳离子移向铜侧。')],
          assistance: { kind: 'none', rounds: 0 },
        },
        {
          nodeId: 'E1',
          errorIds: [],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: [
              { id: 'energy-from', value: 'chemical' },
              { id: 'energy-to', value: 'electric' },
            ],
          },
          evidence: [quoted('化学能直接转化为电能。')],
          assistance: { kind: 'none', rounds: 0 },
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
        text: 'Extract closed-set facts and exact evidence spans without scoring.',
      },
      schemaVersion: 'structured-assessment.v2',
      configVersion: config.configVersion,
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
      configVersions: sessionConfigVersions(config),
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

    expect(assessed.session.events).toHaveLength(5);
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

  it('rejects duplicate or unconfigured node assessments before persisting them', async () => {
    const assessment = {
      nodeId: 'P2',
      errorIds: [],
      facts: {
        response: 'substantive' as const,
        terminology: 'model' as const,
        syllabus: 'within' as const,
        contradiction: false,
        typo: 'none' as const,
        slots: [{ id: 'reducing-agent', value: 'Zn' }],
      },
      evidence: [{ quote: 'Zn', start: 0, end: 2 }],
      assistance: { kind: 'none' as const, rounds: 0 },
    };
    expect(structuredAssessmentResponseSchema.safeParse({
      anchors: [],
      assessments: [assessment, assessment],
    }).success).toBe(false);

    const config = await loadAllConfig(process.cwd());
    const session = createSession({
      id: 'session-invalid-extraction',
      anonymousStudentId: 'anon-A1B2C3D4',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    expect(() => recordStructuredTextAssessment({
      session,
      config,
      answer: {
        id: 'answer-invalid',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-invalid',
        questionId: 'zinc-analysis',
        value: 'Zn',
      },
      extraction: {
        anchors: [],
        assessments: [{ ...assessment, nodeId: 'UNKNOWN' }],
      },
      provenance: {
        promptId: 'assessment',
        promptVersion: 'prompt.v1',
        cacheKey: 'cache-key',
        model: 'mock-v1',
      },
      assessmentEventIdPrefix: 'invalid',
      assessedAt: '2026-07-15T12:01:01.000Z',
    })).toThrow(/No rubric configured/);
  });
});
