import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  evaluateExtractedFacts,
  type ExtractedAssessmentFacts,
} from '../shared/scoring/policy';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import { nextScaffoldLevel } from '../shared/scoring/scaffold';
import { structuredAssessmentResponseSchema } from '../shared/workflows/assessment';

const completeFacts: ExtractedAssessmentFacts = {
  response: 'substantive',
  terminology: 'model',
  syllabus: 'within',
  contradiction: false,
  typo: 'none',
  slots: [{ id: 'electron-from', value: 'Zn' }],
};

describe('runtime adjudication policy contracts', () => {
  it('keeps outcome fields out of the structured extraction contract', () => {
    const extraction = {
      anchors: [],
      assessments: [{
        nodeId: 'P4',
        errorIds: [],
        facts: completeFacts,
        evidence: [{ quote: 'Zn', start: 0, end: 2 }],
        assistance: { kind: 'none', rounds: 0 },
      }],
    };

    expect(structuredAssessmentResponseSchema.safeParse(extraction).success).toBe(true);
    expect(structuredAssessmentResponseSchema.safeParse({
      ...extraction,
      assessments: [{ ...extraction.assessments[0], logicalOutcome: 'hit' }],
    }).success).toBe(false);
    expect(structuredAssessmentResponseSchema.safeParse({
      ...extraction,
      assessments: [{ ...extraction.assessments[0], following: { logicalChainConsistent: true } }],
    }).success).toBe(false);
  });

  it('§1 changes incomplete facts when the outcome scale changes', async () => {
    const config = await loadAllConfig(process.cwd());
    const requirements = [
      { id: 'electron-from', acceptedValues: ['Zn'] },
      { id: 'electron-to', acceptedValues: ['Cu'] },
    ];

    expect(evaluateExtractedFacts({ facts: completeFacts, requirements, policy: config.rubrics.policy }).status)
      .toBe('partial');
    const changed = structuredClone(config.rubrics.policy);
    changed.outcomeScale.mode = 'two-state';
    expect(evaluateExtractedFacts({ facts: completeFacts, requirements, policy: changed }).status)
      .toBe('miss');
  });

  it('§§3-7 deterministically apply terminology, syllabus, contradiction, nonresponse, and typo policy', async () => {
    const config = await loadAllConfig(process.cwd());
    const requirements = [{ id: 'electron-from', acceptedValues: ['Zn'] }];
    const evaluate = (facts: ExtractedAssessmentFacts, policy = config.rubrics.policy) =>
      evaluateExtractedFacts({ facts, requirements, policy });

    const colloquial = { ...completeFacts, terminology: 'colloquial' as const };
    expect(evaluate(colloquial).status).toBe('hit');
    const terminologyChanged = structuredClone(config.rubrics.policy);
    terminologyChanged.terminology.requireModelTermsForHit = true;
    expect(evaluate(colloquial, terminologyChanged).status).toBe('partial');

    const beyond = { ...completeFacts, syllabus: 'beyond' as const };
    expect(evaluate(beyond).status).toBe('hit');
    const beyondChanged = structuredClone(config.rubrics.policy);
    beyondChanged.beyondSyllabus.correctOutcome = 'partial';
    expect(evaluate(beyond, beyondChanged).status).toBe('partial');

    const contradictory = { ...completeFacts, contradiction: true };
    expect(evaluate(contradictory).status).toBe('miss');
    const contradictionChanged = structuredClone(config.rubrics.policy);
    contradictionChanged.contradiction.outcome = 'partial';
    expect(evaluate(contradictory, contradictionChanged).status).toBe('partial');

    const blank = { ...completeFacts, response: 'blank' as const, slots: [] };
    expect(evaluate(blank)).toMatchObject({ status: 'unanswered', includeInDiagnosis: false });
    const nonResponseChanged = structuredClone(config.rubrics.policy);
    nonResponseChanged.nonResponse.status = 'miss';
    nonResponseChanged.nonResponse.includeInDiagnosis = true;
    expect(evaluate(blank, nonResponseChanged)).toMatchObject({ status: 'miss', includeInDiagnosis: true });

    const typo = { ...completeFacts, typo: 'ambiguous' as const };
    expect(evaluate(typo).status).toBe('needs-review');
    const typoChanged = structuredClone(config.rubrics.policy);
    typoChanged.typos.ambiguousStrategy = 'miss';
    expect(evaluate(typo, typoChanged).status).toBe('miss');
  });

  it('§§15-16 make assisted mastery an outcome and consume hint and Socratic settings', async () => {
    const config = await loadAllConfig(process.cwd());
    const base = {
      rubrics: config.rubrics,
      scaffoldPolicy: config.scaffoldPolicy,
      nodeId: 'P4',
      objectiveOutcome: 'hit' as const,
    };

    expect(resolveRubricDecision({
      ...base,
      assistance: { kind: 'hint', rounds: 1 },
    }).ruleDecision.status).toBe('hit-with-help');
    expect(resolveRubricDecision({
      ...base,
      assistance: { kind: 'socratic', rounds: 3 },
    }).ruleDecision.status).toBe('hit-with-help');
    expect(resolveRubricDecision({
      ...base,
      assistance: { kind: 'socratic', rounds: 4 },
    }).ruleDecision.status).toBe('partial');

    const changed = structuredClone(config.scaffoldPolicy);
    changed.assistance.correctOutcome = 'hit';
    changed.socratic.maxRounds = 1;
    expect(resolveRubricDecision({
      ...base,
      scaffoldPolicy: changed,
      assistance: { kind: 'hint', rounds: 1 },
    }).ruleDecision.status).toBe('hit');
    expect(resolveRubricDecision({
      ...base,
      scaffoldPolicy: changed,
      assistance: { kind: 'socratic', rounds: 2 },
    }).ruleDecision.status).toBe('partial');
  });

  it('§15 promotion behavior changes with countsForPromotion', async () => {
    const config = await loadAllConfig(process.cwd());
    expect(nextScaffoldLevel(1, ['hit', 'hit-with-help'], config.scaffoldPolicy).action).toBe('stay');
    const changed = structuredClone(config.scaffoldPolicy);
    changed.assistance.countsForPromotion = true;
    expect(nextScaffoldLevel(1, ['hit', 'hit-with-help'], changed).action).toBe('promote');
  });
});
