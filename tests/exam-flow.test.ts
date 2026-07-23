import { describe, expect, it } from 'vitest';

import {
  originalExamFillKind,
  originalExamPrompt,
  originalExamTitle,
  resolveOriginalExamChoice,
} from '../src/features/pretest/exam-flow';

describe('original exam fill-to-choice mapping', () => {
  it('preserves the existing Q1 mappings', () => {
    expect(resolveOriginalExamChoice('pretest-exam1-polarity', '负|正')).toBe('A');
    expect(resolveOriginalExamChoice('pretest-exam1-electron-flow', 'a|b')).toBe('A');
    expect(resolveOriginalExamChoice('pretest-exam1-stoichiometry', '1:1')).toBe('A');
    expect(resolveOriginalExamChoice('pretest-exam1-stoichiometry', '未识别')).toBeNull();
  });

  it('maps Q4 polarity answers and sends unrecognized input to the fallback', () => {
    expect(resolveOriginalExamChoice('pretest-exam4-polarity', '正极 | 负 极')).toBe('A');
    expect(resolveOriginalExamChoice('pretest-exam4-polarity', '负|正')).toBe('B');
    expect(resolveOriginalExamChoice('pretest-exam4-polarity', '正|正')).toBe('C');
    expect(resolveOriginalExamChoice('pretest-exam4-polarity', '左|右')).toBe('D');
  });

  it('normalizes Q4 material names, formulas, width, case, and subscripts', () => {
    expect(resolveOriginalExamChoice(
      'pretest-exam4-material',
      ' 纳米 ＣｕＯ ／ 导电聚合物（ＣｕＯ） ',
    )).toBe('A');
    expect(resolveOriginalExamChoice('pretest-exam4-material', '氧化铜')).toBe('A');
    expect(resolveOriginalExamChoice('pretest-exam4-material', '氧化亚铜')).toBe('B');
    expect(resolveOriginalExamChoice('pretest-exam4-material', '石 墨')).toBe('C');
    expect(resolveOriginalExamChoice('pretest-exam4-material', 'Ｃ₆Ｈ₁₂Ｏ₆')).toBe('D');
    expect(resolveOriginalExamChoice('pretest-exam4-material', '银')).toBe('E');
  });

  it('shares substance normalization for the Q4 electron-loser blank', () => {
    expect(resolveOriginalExamChoice('pretest-exam4-electron-loser', 'Cu₂O')).toBe('A');
    expect(resolveOriginalExamChoice('pretest-exam4-electron-loser', '葡萄糖')).toBe('B');
    expect(resolveOriginalExamChoice('pretest-exam4-electron-loser', '氧化铜')).toBe('C');
    expect(resolveOriginalExamChoice('pretest-exam4-electron-loser', 'C₆H₁₂O₇')).toBe('D');
    expect(resolveOriginalExamChoice('pretest-exam4-electron-loser', '电子')).toBe('E');
  });

  it('normalizes accepted Q4 amounts while preserving known distractors', () => {
    for (const answer of ['0.2', '.2', '0.20', '2×10⁻¹']) {
      expect(resolveOriginalExamChoice('pretest-exam4-stoichiometry', answer)).toBe('A');
    }
    expect(resolveOriginalExamChoice('pretest-exam4-stoichiometry', '0.1')).toBe('B');
    expect(resolveOriginalExamChoice('pretest-exam4-stoichiometry', '2×10⁻²')).toBe('C');
    expect(resolveOriginalExamChoice('pretest-exam4-stoichiometry', '2 / 200')).toBe('D');
    expect(resolveOriginalExamChoice('pretest-exam4-stoichiometry', '0.3')).toBe('E');
  });

  it('exposes the original Q4 fill prompts and group title', () => {
    expect(originalExamFillKind('pretest-exam4-polarity')).toBe('polarity');
    expect(originalExamFillKind('pretest-exam4-material')).toBe('substance');
    expect(originalExamFillKind('pretest-exam4-electron-loser')).toBe('substance');
    expect(originalExamFillKind('pretest-exam4-stoichiometry')).toBe('amount');
    expect(originalExamPrompt('pretest-exam4-polarity'))
      .toBe('该电池中，电极 a 为______极，电极 b 为______极。');
    expect(originalExamPrompt('pretest-exam4-material')).toBe('b 电极的电极材料是______。');
    expect(originalExamPrompt('pretest-exam4-electron-loser'))
      .toBe('在 b 电极上，实际失电子的物质是______。');
    expect(originalExamPrompt('pretest-exam4-stoichiometry'))
      .toBe('消耗 18 mg 葡萄糖（C₆H₁₂O₆，M=180 g/mol）时，理论上 a 电极有______ mmol 电子流入。');
    expect(originalExamTitle('exam-q4-glucose')).toBe('血糖微型电池');
  });
});
