export type OriginalExamFillKind = 'polarity' | 'electron-flow' | 'ratio';

const ORIGINAL_EXAM_FILL_KINDS: Record<string, OriginalExamFillKind> = {
  'pretest-exam1-polarity': 'polarity',
  'pretest-exam1-electron-flow': 'electron-flow',
  'pretest-exam1-stoichiometry': 'ratio',
};

const ORIGINAL_EXAM_PROMPTS: Record<string, string> = {
  'pretest-exam1-polarity': '该电池中，电极 a 为______极，电极 b 为______极。',
  'pretest-exam1-electron-flow': '放电时，外电路中电子从______极流向______极（填 a 或 b）。',
  'pretest-exam1-stoichiometry': '该电池放电时，消耗 K 与消耗 O₂ 的物质的量之比为______。',
};

export function originalExamFillKind(questionId: string) {
  return ORIGINAL_EXAM_FILL_KINDS[questionId] ?? null;
}

export function originalExamPrompt(questionId: string) {
  return ORIGINAL_EXAM_PROMPTS[questionId] ?? null;
}

export function originalExamTitle(groupId: string) {
  return groupId === 'exam-q1-k-o2' ? 'K—O₂ 电池' : null;
}

export function splitFillAnswer(answer: string) {
  const [first = '', second = ''] = answer.split('|', 2);
  return [first, second] as const;
}

export function joinFillAnswer(first: string, second: string) {
  return `${first}|${second}`;
}

export function hasVisibleAnswer(answer: string) {
  return answer.replaceAll('|', '').trim().length > 0;
}

const LEGACY_CHOICE_PATTERN = /^[A-D]$/;

export function originalExamDisplayAnswer(questionId: string, answer: string) {
  const optionId = answer.trim().toUpperCase();
  if (!LEGACY_CHOICE_PATTERN.test(optionId)) return answer;

  const kind = originalExamFillKind(questionId);
  if (kind === 'ratio') {
    return {
      A: '1:1',
      B: '2:1',
      C: '4:1',
      D: '1:2',
    }[optionId] ?? answer;
  }

  if (kind === 'polarity') {
    return {
      A: '负|正',
      B: '正|负',
      C: '负|负',
      D: '',
    }[optionId] ?? answer;
  }

  if (kind === 'electron-flow') {
    return {
      A: 'a|b',
      B: 'b|a',
      C: '',
      D: '',
    }[optionId] ?? answer;
  }

  return answer;
}

function normalize(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll('：', ':')
    .replaceAll('极', '')
    .replace(/\s+/g, '');
}

/**
 * The source exam uses blanks rather than options. The stored assessment still
 * uses the existing deterministic choice rubric, so these short responses map
 * back to the configured option IDs without showing the options to students.
 */
export function resolveOriginalExamChoice(questionId: string, answer: string) {
  const kind = originalExamFillKind(questionId);
  if (!kind) return answer;

  const legacyOptionId = answer.trim().toUpperCase();
  if (LEGACY_CHOICE_PATTERN.test(legacyOptionId)) return legacyOptionId;

  if (kind === 'ratio') {
    const optionByRatio: Record<string, string> = {
      '1:1': 'A',
      '2:1': 'B',
      '4:1': 'C',
      '1:2': 'D',
    };
    return optionByRatio[normalize(answer)] ?? null;
  }

  const [rawFirst, rawSecond] = splitFillAnswer(answer);
  const first = normalize(rawFirst);
  const second = normalize(rawSecond);
  if (!first || !second) return null;

  if (kind === 'polarity') {
    if (first.includes('负') && second.includes('正')) return 'A';
    if (first.includes('正') && second.includes('负')) return 'B';
    if (first.includes('负') && second.includes('负')) return 'C';
    return 'D';
  }

  if (first === 'a' && second === 'b') return 'A';
  if (first === 'b' && second === 'a') return 'B';
  return null;
}
