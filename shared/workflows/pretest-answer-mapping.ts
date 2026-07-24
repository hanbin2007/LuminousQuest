const fillKinds = {
  'pretest-exam1-polarity': 'polarity',
  'pretest-exam1-electron-flow': 'electron-flow',
  'pretest-exam1-stoichiometry': 'ratio',
  'pretest-exam4-polarity': 'polarity',
  'pretest-exam4-material': 'substance',
  'pretest-exam4-electron-loser': 'substance',
  'pretest-exam4-stoichiometry': 'amount',
} as const;

const legacyOptions: Record<string, readonly string[]> = {
  'pretest-exam1-polarity': ['A', 'B', 'C', 'D'],
  'pretest-exam1-electron-flow': ['A', 'B', 'C', 'D'],
  'pretest-exam1-stoichiometry': ['A', 'B', 'C', 'D'],
  'pretest-exam4-polarity': ['A', 'B', 'C', 'D'],
  'pretest-exam4-material': ['A', 'B', 'C', 'D', 'E'],
  'pretest-exam4-electron-loser': ['A', 'B', 'C', 'D', 'E'],
  'pretest-exam4-stoichiometry': ['A', 'B', 'C', 'D', 'E'],
};

function split(answer: string) {
  const [first = '', second = ''] = answer.split('|', 2);
  return [first, second] as const;
}

function normalize(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replaceAll('：', ':')
    .replaceAll('极', '')
    .replace(/\s+/gu, '');
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

export function resolvePretestOriginalAnswer(questionId: string, answer: string) {
  const kind = fillKinds[questionId as keyof typeof fillKinds];
  if (!kind) return answer;
  const legacyOptionId = answer.trim().toUpperCase();
  if (legacyOptions[questionId]?.includes(legacyOptionId)) return legacyOptionId;

  if (questionId === 'pretest-exam4-polarity') {
    const [rawFirst, rawSecond] = split(answer);
    const first = normalize(rawFirst);
    const second = normalize(rawSecond);
    if (!first || !second) return null;
    if (first.includes('正') && second.includes('负')) return 'A';
    if (first.includes('负') && second.includes('正')) return 'B';
    if (first.includes('正') && second.includes('正')) return 'C';
    return 'D';
  }

  if (questionId === 'pretest-exam4-material') {
    const value = normalizeSubstance(answer);
    if (
      value === 'cuo'
      || value === '纳米cuo'
      || value === '纳米cuo/导电聚合物'
      || value === '纳米cuo/导电聚合物(cuo)'
    ) return 'A';
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
    return ({
      '1:1': 'A',
      '2:1': 'B',
      '4:1': 'C',
      '1:2': 'D',
    } as Record<string, string>)[normalize(answer)] ?? null;
  }

  const [rawFirst, rawSecond] = split(answer);
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
