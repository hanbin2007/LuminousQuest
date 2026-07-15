import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  ExtractionValidationError,
  validateAssessmentExtraction,
} from '../shared/workflows/extraction-validation';
import type { StructuredAssessmentResponse } from '../shared/workflows/assessment';

async function fixture() {
  return loadAllConfig(process.cwd());
}

function extraction(
  quote: string,
  start = 0,
  end = quote.length,
): StructuredAssessmentResponse {
  return {
    anchors: [],
    assessments: [{
      nodeId: 'P4',
      errorIds: ['P4-M1'],
      facts: {
        response: 'substantive',
        terminology: 'model',
        syllabus: 'within',
        contradiction: false,
        typo: 'unambiguous',
        slots: [
          { id: 'electron-from', value: 'Zn' },
          { id: 'electron-to', value: 'Cu' },
        ],
      },
      evidence: [{ quote, start, end }],
      assistance: { kind: 'none', rounds: 0 },
    }],
  };
}

describe('closed-set extraction validation', () => {
  it('repairs citations after full-width, whitespace, and configured typo normalization', async () => {
    const config = await fixture();
    const answer = '  电子由负级流向正极，Ｚｎ被氧化。';
    const result = validateAssessmentExtraction({
      extraction: extraction('电子由负极流向正极, Zn被氧化', 99, 120),
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    });

    expect(result.assessments[0].evidence[0]).toEqual({
      quote: '电子由负级流向正极，Ｚｎ被氧化',
      start: 2,
      end: answer.length - 1,
    });
  });

  it('rejects node and error ids outside the configured per-node closed set', async () => {
    const config = await fixture();
    const invalid = extraction('电子由负极流向正极');
    invalid.assessments[0].nodeId = 'NOT-A-NODE';
    invalid.assessments[0].errorIds = ['P2-M1'];

    expect(() => validateAssessmentExtraction({
      extraction: invalid,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(ExtractionValidationError);

    try {
      validateAssessmentExtraction({
        extraction: invalid,
        answer: '电子由负极流向正极',
        caseId: 'zinc-copper',
        targetNodeIds: ['P4'],
        config,
      });
    } catch (error) {
      expect(error).toMatchObject({ category: 'closed-set', retryable: true });
    }
  });

  it('rejects an error id that belongs to a different configured node', async () => {
    const config = await fixture();
    const invalid = extraction('电子由负极流向正极');
    invalid.assessments[0].errorIds = ['P2-M1'];

    expect(() => validateAssessmentExtraction({
      extraction: invalid,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set', retryable: true }));
  });

  it('rejects unknown cases, target sets, and anchor ids as closed-set failures', async () => {
    const config = await fixture();
    const value = extraction('电子由负极流向正极');
    expect(() => validateAssessmentExtraction({
      extraction: value,
      answer: '电子由负极流向正极',
      caseId: 'missing-case',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set' }));
    expect(() => validateAssessmentExtraction({
      extraction: value,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P2'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set' }));

    const unknownAnchor = structuredClone(value);
    unknownAnchor.anchors = [{
      anchorId: 'missing-anchor',
      facts: [{ id: 'negative', value: 'Zn' }],
      evidence: [{ quote: '负极', start: 3, end: 5 }],
    }];
    expect(() => validateAssessmentExtraction({
      extraction: unknownAnchor,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set' }));
  });

  it('requires evidence only for substantive assessments', async () => {
    const config = await fixture();
    const missingEvidence = extraction('电子由负极流向正极');
    missingEvidence.assessments[0].evidence = [];
    expect(() => validateAssessmentExtraction({
      extraction: missingEvidence,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'citation-mismatch' }));

    missingEvidence.assessments[0].facts.response = 'blank';
    expect(validateAssessmentExtraction({
      extraction: missingEvidence,
      answer: '',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    }).assessments[0].evidence).toEqual([]);
  });

  it('classifies a near citation above the configured threshold as normalization-insufficient', async () => {
    const config = await fixture();
    config.scaffoldPolicy.extraction.citation.maxEditDistanceRatio = 0.05;
    const answer = '电子从负机流向正极';

    expect(() => validateAssessmentExtraction({
      extraction: extraction('电子从负极流向正极'),
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'normalization-insufficient',
      retryable: false,
    }));
  });

  it('classifies an unrelated citation as a retryable model hallucination', async () => {
    const config = await fixture();

    expect(() => validateAssessmentExtraction({
      extraction: extraction('电子从负极流向正极'),
      answer: '我不会',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'citation-mismatch',
      retryable: true,
    }));
  });
});
