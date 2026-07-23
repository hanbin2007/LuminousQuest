export type OriginalExamFillKind =
  | 'polarity'
  | 'electron-flow'
  | 'ratio'
  | 'substance'
  | 'amount';

const ORIGINAL_EXAM_FILL_KINDS: Record<string, OriginalExamFillKind> = {
  'pretest-exam1-polarity': 'polarity',
  'pretest-exam1-electron-flow': 'electron-flow',
  'pretest-exam1-stoichiometry': 'ratio',
  'pretest-exam4-polarity': 'polarity',
  'pretest-exam4-material': 'substance',
  'pretest-exam4-electron-loser': 'substance',
  'pretest-exam4-stoichiometry': 'amount',
};

const ORIGINAL_EXAM_PROMPTS: Record<string, string> = {
  'pretest-exam1-polarity': '该电池中，电极 a 为______极，电极 b 为______极。',
  'pretest-exam1-electron-flow': '放电时，外电路中电子从______极流向______极（填 a 或 b）。',
  'pretest-exam1-stoichiometry': '该电池放电时，消耗 K 与消耗 O₂ 的物质的量之比为______。',
  'pretest-exam4-polarity': '该电池中，电极 a 为______极，电极 b 为______极。',
  'pretest-exam4-material': 'b 电极的电极材料是______。',
  'pretest-exam4-electron-loser': '在 b 电极上，实际失电子的物质是______。',
  'pretest-exam4-stoichiometry':
    '消耗 18 mg 葡萄糖（C₆H₁₂O₆，M=180 g/mol）时，理论上 a 电极有______ mmol 电子流入。',
};

const ORIGINAL_EXAM_DISPLAY_ANSWERS: Record<string, Record<string, string>> = {
  'pretest-exam1-polarity': {
    A: '负|正',
    B: '正|负',
    C: '负|负',
    D: '',
  },
  'pretest-exam1-electron-flow': {
    A: 'a|b',
    B: 'b|a',
    C: '',
    D: '',
  },
  'pretest-exam1-stoichiometry': {
    A: '1:1',
    B: '2:1',
    C: '4:1',
    D: '1:2',
  },
  'pretest-exam4-polarity': {
    A: '正|负',
    B: '负|正',
    C: '正|正',
    D: '',
  },
  'pretest-exam4-material': {
    A: 'CuO',
    B: 'Cu₂O',
    C: '石墨',
    D: 'C₆H₁₂O₆',
    E: '',
  },
  'pretest-exam4-electron-loser': {
    A: 'Cu₂O',
    B: 'C₆H₁₂O₆',
    C: 'CuO',
    D: 'C₆H₁₂O₇',
    E: '',
  },
  'pretest-exam4-stoichiometry': {
    A: '0.2',
    B: '0.1',
    C: '0.02',
    D: '2/200',
    E: '',
  },
};

export function originalExamFillKind(questionId: string) {
  return ORIGINAL_EXAM_FILL_KINDS[questionId] ?? null;
}

export function originalExamPrompt(questionId: string) {
  return ORIGINAL_EXAM_PROMPTS[questionId] ?? null;
}

export function originalExamTitle(groupId: string) {
  return {
    'exam-q1-k-o2': 'K—O₂ 电池',
    'exam-q4-glucose': '血糖微型电池',
  }[groupId] ?? null;
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

export function originalExamDisplayAnswer(questionId: string, answer: string) {
  if (originalExamFillKind(questionId) === 'substance') return answer;
  const optionId = answer.trim().toUpperCase();
  return ORIGINAL_EXAM_DISPLAY_ANSWERS[questionId]?.[optionId] ?? answer;
}

function normalize(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll('：', ':')
    .replaceAll('极', '')
    .replace(/\s+/g, '');
}

function normalizeSubstance(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replaceAll('氧化亚铜', 'cu2o')
    .replaceAll('氧化铜', 'cuo')
    .replaceAll('葡萄糖酸', 'c6h12o7')
    .replaceAll('葡萄糖', 'c6h12o6');
}

function normalizeAmount(value: string) {
  const compact = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[−–—]/gu, '-');
  if (compact === '2/200') return compact;

  const scientific = compact.match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))[×x*]10\^?([+-]?\d+)$/,
  );
  const numeric = scientific
    ? Number(scientific[1]) * (10 ** Number(scientific[2]))
    : Number(compact);
  return Number.isFinite(numeric) ? String(numeric) : compact;
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
  if (Object.hasOwn(ORIGINAL_EXAM_DISPLAY_ANSWERS[questionId] ?? {}, legacyOptionId)) {
    return legacyOptionId;
  }

  if (questionId === 'pretest-exam4-polarity') {
    const [rawFirst, rawSecond] = splitFillAnswer(answer.normalize('NFKC'));
    const first = normalize(rawFirst);
    const second = normalize(rawSecond);
    if (first.includes('正') && second.includes('负')) return 'A';
    if (first.includes('负') && second.includes('正')) return 'B';
    if (first.includes('正') && second.includes('正')) return 'C';
    return 'D';
  }

  if (questionId === 'pretest-exam4-material') {
    const value = normalizeSubstance(answer);
    if (value === 'cuo'
      || value === '纳米cuo/导电聚合物'
      || value === '纳米cuo/导电聚合物(cuo)') return 'A';
    if (value === 'cu2o') return 'B';
    if (value === '石墨') return 'C';
    if (value === 'c6h12o6') return 'D';
    return 'E';
  }

  if (questionId === 'pretest-exam4-electron-loser') {
    const value = normalizeSubstance(answer);
    if (value === 'cu2o') return 'A';
    if (value === 'c6h12o6') return 'B';
    if (value === 'cuo') return 'C';
    if (value === 'c6h12o7') return 'D';
    return 'E';
  }

  if (questionId === 'pretest-exam4-stoichiometry') {
    const value = normalizeAmount(answer);
    if (value === '0.2') return 'A';
    if (value === '0.1') return 'B';
    if (value === '0.02') return 'C';
    if (value === '2/200') return 'D';
    return 'E';
  }

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
