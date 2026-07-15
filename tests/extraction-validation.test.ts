import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  ExtractionValidationError,
  validateAssessmentExtraction,
} from '../shared/workflows/extraction-validation';

async function fixture() {
  return loadAllConfig(process.cwd());
}

function extraction(quote: string, start = 0, end = quote.length) {
  return {
    anchors: [],
    assessments: [{
      nodeId: 'P4',
      errorIds: ['P4-M1'],
      facts: {
        response: 'substantive' as const,
        terminology: 'model' as const,
        syllabus: 'within' as const,
        contradiction: false,
        typo: 'unambiguous' as const,
        slots: [
          { id: 'electron-from', value: 'Zn' },
          { id: 'electron-to', value: 'Cu' },
        ],
      },
      evidence: [{ quote, start, end }],
      assistance: { kind: 'none' as const, rounds: 0 },
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
