import type { CaseConfig } from '../config/schemas';

export const equationGrammarVersion = 'equation-grammar.v1';
export const equationScoringEngineVersion = 'equation-scoring.v1';

export type EquationTokenKind =
  | 'element'
  | 'number'
  | 'electron'
  | 'arrow'
  | 'plus'
  | 'charge-sign'
  | 'caret'
  | 'paren-open'
  | 'paren-close'
  | 'bracket-open'
  | 'bracket-close'
  | 'state';

export interface EquationToken {
  kind: EquationTokenKind;
  value: string;
  start: number;
  end: number;
}

export class EquationParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at position ${position}`);
    this.name = 'EquationParseError';
  }
}

export interface ParsedSpecies {
  coefficient: number;
  formula: string;
  elements: Record<string, number>;
  charge: number;
  electron: boolean;
  state?: 's' | 'l' | 'g' | 'aq';
}

export interface ParsedEquation {
  source: string;
  normalizedSource: string;
  arrow: '->' | '=';
  reactants: ParsedSpecies[];
  products: ParsedSpecies[];
}

export type EquationMedium = 'acidic' | 'alkaline' | 'neutral' | 'molten';
export type ExpectedElectronSide = 'reactant' | 'product' | 'none';

export interface AnalyzeEquationOptions {
  kind: 'half' | 'overall';
  medium: EquationMedium;
  expectedElectronSide: ExpectedElectronSide;
}

export interface ParsedEquationAnalysis {
  status: 'parsed';
  grammarVersion: typeof equationGrammarVersion;
  source: string;
  parsed: ParsedEquation;
  canonical: string;
  conservation: {
    atoms: { balanced: boolean; difference: Record<string, number> };
    charge: { balanced: boolean; reactants: number; products: number };
    electrons: {
      balanced: boolean;
      actualSide: ExpectedElectronSide | 'both';
      expectedSide: ExpectedElectronSide;
      count: number;
      reactants: number;
      products: number;
    };
  };
  medium: { matches: boolean; forbiddenSpecies: string[] };
  valid: boolean;
}

export interface EquationParseFailure {
  status: 'parse-error';
  grammarVersion: typeof equationGrammarVersion;
  source: string;
  error: { message: string; position: number };
}

export type EquationAnalysis = ParsedEquationAnalysis | EquationParseFailure;

export interface EquationScoreNodeDecision {
  nodeId: 'P3' | 'P6' | 'P7';
  outcome: 'hit' | 'partial' | 'miss';
  reasons: string[];
}

export interface EquationScore {
  outcome: 'hit' | 'partial' | 'miss';
  ruleId:
    | 'equation-hit'
    | 'equation-medium-partial'
    | 'equation-balance-partial'
    | 'equation-parse-miss'
    | 'equation-miss';
  analysis: EquationAnalysis;
  matchedCanonical?: string;
  nodeDecisions: EquationScoreNodeDecision[];
}

type EquationSet = CaseConfig['equationSets'][number];

const superscriptDigits: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
};

const subscriptDigits: Record<string, string> = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
};

function normalizeEquationSource(source: string) {
  let normalized = source
    .replace(/−/g, '-')
    .replace(/→/g, '->')
    .replace(/⇌/g, '=');
  normalized = normalized.replace(/[⁰¹²³⁴-⁹]+[⁺⁻]/g, (value) => {
    const sign = value.at(-1) === '⁺' ? '+' : '-';
    const magnitude = [...value.slice(0, -1)].map((digit) => superscriptDigits[digit]).join('');
    return `^${magnitude}${sign}`;
  });
  normalized = normalized.replace(/[⁺⁻]/g, (value) => `^${value === '⁺' ? '+' : '-'}`);
  normalized = normalized.replace(/[₀-₉]/g, (value) => subscriptDigits[value]);
  return normalized;
}

export function tokenizeEquation(source: string): EquationToken[] {
  const normalized = normalizeEquationSource(source);
  const tokens: EquationToken[] = [];
  let index = 0;
  const push = (kind: EquationTokenKind, value: string, length = value.length) => {
    tokens.push({ kind, value, start: index, end: index + length });
    index += length;
  };

  while (index < normalized.length) {
    const rest = normalized.slice(index);
    const character = normalized[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (rest.startsWith('->')) {
      push('arrow', '->', 2);
      continue;
    }
    if (character === '=') {
      push('arrow', '=');
      continue;
    }
    const state = rest.match(/^\((aq|s|l|g)\)/);
    if (state) {
      push('state', state[1], state[0].length);
      continue;
    }
    const electron = rest.match(/^e(?:\^)?-/);
    if (electron) {
      push('electron', 'e^-', electron[0].length);
      continue;
    }
    const element = rest.match(/^[A-Z][a-z]?/);
    if (element) {
      push('element', element[0]);
      continue;
    }
    const number = rest.match(/^\d+/);
    if (number) {
      push('number', number[0]);
      continue;
    }
    const simpleTokens: Partial<Record<string, EquationTokenKind>> = {
      '+': 'plus',
      '-': 'charge-sign',
      '^': 'caret',
      '(': 'paren-open',
      ')': 'paren-close',
      '[': 'bracket-open',
      ']': 'bracket-close',
    };
    const kind = simpleTokens[character];
    if (kind) {
      push(kind, character);
      continue;
    }
    throw new EquationParseError(`Unsupported token ${JSON.stringify(character)}`, index);
  }
  return tokens;
}

function findArrow(source: string) {
  const arrows: Array<{ index: number; value: '->' | '='; length: number }> = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith('->', index)) {
      arrows.push({ index, value: '->', length: 2 });
      index += 1;
    } else if (source[index] === '=') {
      arrows.push({ index, value: '=', length: 1 });
    }
  }
  if (arrows.length !== 1) {
    throw new EquationParseError(
      arrows.length === 0 ? 'Equation requires one arrow' : 'Equation has multiple arrows',
      arrows[1]?.index ?? source.length,
    );
  }
  return arrows[0];
}

function isSeparatorPlus(side: string, index: number) {
  const previous = side[index - 1];
  const next = side[index + 1];
  if (previous === '^') return false;
  if (/^\((aq|s|l|g)\)/.test(side.slice(index + 1))) return false;
  if (next === '+') return false;
  if (previous === '+') return true;
  if (previous !== undefined && /\s/.test(previous)) return true;
  if (next !== undefined && /[A-Z([\de]/.test(next)) return true;
  return false;
}

function splitSide(side: string, baseOffset: number) {
  const terms: Array<{ value: string; offset: number }> = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < side.length; index += 1) {
    const character = side[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    if (depth < 0) throw new EquationParseError('Unexpected closing group', baseOffset + index);
    if (character === '+' && depth === 0 && isSeparatorPlus(side, index)) {
      const value = side.slice(start, index).trim();
      if (value.length === 0) throw new EquationParseError('Missing species', baseOffset + index);
      const raw = side.slice(start, index);
      terms.push({ value, offset: baseOffset + start + raw.indexOf(value) });
      start = index + 1;
    }
  }
  if (depth !== 0) throw new EquationParseError('Unclosed formula group', baseOffset + side.length);
  const value = side.slice(start).trim();
  if (value.length === 0) {
    const separator = side.lastIndexOf('+');
    throw new EquationParseError('Missing species', baseOffset + Math.max(separator, 0));
  }
  const raw = side.slice(start);
  terms.push({ value, offset: baseOffset + start + raw.indexOf(value) });
  return terms;
}

function addElements(target: Map<string, number>, source: Map<string, number>, multiplier: number) {
  for (const [element, count] of source) {
    target.set(element, (target.get(element) ?? 0) + count * multiplier);
  }
}

function parseFormula(formula: string, offset: number) {
  let index = 0;
  const parseSequence = (closing?: ')' | ']'): Map<string, number> => {
    const elements = new Map<string, number>();
    let parsedAny = false;
    while (index < formula.length) {
      const character = formula[index];
      if (closing && character === closing) {
        index += 1;
        return elements;
      }
      if (character === ')' || character === ']') {
        throw new EquationParseError(`Unexpected ${character}`, offset + index);
      }
      if (character === '(' || character === '[') {
        parsedAny = true;
        const expectedClosing = character === '(' ? ')' : ']';
        index += 1;
        const group = parseSequence(expectedClosing);
        const multiplierMatch = formula.slice(index).match(/^\d+/);
        const multiplier = multiplierMatch ? Number(multiplierMatch[0]) : 1;
        if (multiplier === 0) throw new EquationParseError('Subscript must be positive', offset + index);
        if (multiplierMatch) index += multiplierMatch[0].length;
        addElements(elements, group, multiplier);
        continue;
      }
      const element = formula.slice(index).match(/^[A-Z][a-z]?/);
      if (!element) throw new EquationParseError('Expected element or group', offset + index);
      parsedAny = true;
      index += element[0].length;
      const subscriptMatch = formula.slice(index).match(/^\d+/);
      const subscript = subscriptMatch ? Number(subscriptMatch[0]) : 1;
      if (subscript === 0) throw new EquationParseError('Subscript must be positive', offset + index);
      if (subscriptMatch) index += subscriptMatch[0].length;
      elements.set(element[0], (elements.get(element[0]) ?? 0) + subscript);
    }
    if (closing) throw new EquationParseError(`Missing ${closing}`, offset + index);
    if (!parsedAny) throw new EquationParseError('Formula cannot be empty', offset);
    return elements;
  };

  const elements = parseSequence();
  if (index !== formula.length) throw new EquationParseError('Unexpected formula suffix', offset + index);
  return Object.fromEntries([...elements.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function parseTerm(value: string, offset: number): ParsedSpecies {
  let body = value;
  let coefficient = 1;
  const coefficientMatch = body.match(/^\d+/);
  if (coefficientMatch) {
    coefficient = Number(coefficientMatch[0]);
    if (coefficient === 0) throw new EquationParseError('Coefficient must be positive', offset);
    body = body.slice(coefficientMatch[0].length).trimStart();
    offset += value.length - body.length;
  }

  let state: ParsedSpecies['state'];
  const stateMatch = body.match(/\((aq|s|l|g)\)$/);
  if (stateMatch) {
    state = stateMatch[1] as ParsedSpecies['state'];
    body = body.slice(0, -stateMatch[0].length).trimEnd();
  }
  if (/^e(?:\^)?-$/.test(body)) {
    return { coefficient, formula: 'e', elements: {}, charge: -1, electron: true, ...(state ? { state } : {}) };
  }

  let charge = 0;
  const explicitCharge = body.match(/\^(\d*)([+-])$/);
  if (explicitCharge) {
    const magnitude = explicitCharge[1] === '' ? 1 : Number(explicitCharge[1]);
    if (magnitude === 0) throw new EquationParseError('Charge magnitude must be positive', offset + body.length);
    charge = explicitCharge[2] === '+' ? magnitude : -magnitude;
    body = body.slice(0, -explicitCharge[0].length);
  } else {
    const implicitCharge = body.match(/([+-])$/);
    if (implicitCharge) {
      const sign = implicitCharge[1] === '+' ? 1 : -1;
      body = body.slice(0, -1);
      const monatomic = body.match(/^([A-Z][a-z]?)(\d+)$/);
      if (monatomic) {
        charge = sign * Number(monatomic[2]);
        body = monatomic[1];
      } else {
        charge = sign;
      }
    }
  }
  if (body.length === 0) throw new EquationParseError('Species formula is missing', offset);
  const elements = parseFormula(body, offset);
  return {
    coefficient,
    formula: body,
    elements,
    charge,
    electron: false,
    ...(state ? { state } : {}),
  };
}

export function parseEquation(source: string): ParsedEquation {
  const normalizedSource = normalizeEquationSource(source);
  tokenizeEquation(source);
  const arrow = findArrow(normalizedSource);
  const reactantSource = normalizedSource.slice(0, arrow.index);
  const productSource = normalizedSource.slice(arrow.index + arrow.length);
  const reactants = splitSide(reactantSource, 0).map((term) => parseTerm(term.value, term.offset));
  const products = splitSide(productSource, arrow.index + arrow.length).map((term) =>
    parseTerm(term.value, term.offset));
  return { source, normalizedSource, arrow: arrow.value, reactants, products };
}

function elementOrder(elements: readonly string[]) {
  if (!elements.includes('C')) return [...elements].sort((left, right) => left.localeCompare(right));
  return [
    'C',
    ...(elements.includes('H') ? ['H'] : []),
    ...elements.filter((element) => element !== 'C' && element !== 'H').sort((left, right) => left.localeCompare(right)),
  ];
}

function speciesKey(species: ParsedSpecies) {
  if (species.electron) return '@electron|-1';
  const elements = elementOrder(Object.keys(species.elements))
    .map((element) => `${element}:${species.elements[element]}`)
    .join(',');
  return `${elements}|${species.charge}`;
}

function sideMap(species: readonly ParsedSpecies[]) {
  const result = new Map<string, number>();
  for (const entry of species) result.set(speciesKey(entry), (result.get(speciesKey(entry)) ?? 0) + entry.coefficient);
  return result;
}

function simplifiedSides(equation: ParsedEquation) {
  const reactants = sideMap(equation.reactants);
  const products = sideMap(equation.products);
  for (const key of new Set([...reactants.keys(), ...products.keys()])) {
    const common = Math.min(reactants.get(key) ?? 0, products.get(key) ?? 0);
    if (common === 0) continue;
    reactants.set(key, reactants.get(key)! - common);
    products.set(key, products.get(key)! - common);
    if (reactants.get(key) === 0) reactants.delete(key);
    if (products.get(key) === 0) products.delete(key);
  }
  return { reactants, products };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function canonicalizeParsedEquation(equation: ParsedEquation) {
  const sides = simplifiedSides(equation);
  const coefficients = [...sides.reactants.values(), ...sides.products.values()];
  const divisor = coefficients.reduce((value, coefficient) => greatestCommonDivisor(value, coefficient), 0) || 1;
  const serialize = (side: Map<string, number>) => [...side.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, coefficient]) => `${coefficient / divisor}*${key}`)
    .join(' + ');
  return `${serialize(sides.reactants)} -> ${serialize(sides.products)}`;
}

export function canonicalizeEquation(source: string) {
  return canonicalizeParsedEquation(parseEquation(source));
}

function totalsForSide(species: readonly ParsedSpecies[]) {
  const elements = new Map<string, number>();
  let charge = 0;
  let electrons = 0;
  for (const entry of species) {
    addElements(elements, new Map(Object.entries(entry.elements)), entry.coefficient);
    charge += entry.charge * entry.coefficient;
    if (entry.electron) electrons += entry.coefficient;
  }
  return { elements, charge, electrons };
}

function actualElectronSide(reactants: number, products: number): ExpectedElectronSide | 'both' {
  if (reactants > 0 && products > 0) return 'both';
  if (reactants > 0) return 'reactant';
  if (products > 0) return 'product';
  return 'none';
}

function sameComposition(species: ParsedSpecies, elements: Record<string, number>, charge: number) {
  const keys = new Set([...Object.keys(species.elements), ...Object.keys(elements)]);
  return species.charge === charge && [...keys].every(
    (element) => (species.elements[element] ?? 0) === (elements[element] ?? 0),
  );
}

function mediumCheck(equation: ParsedEquation, medium: EquationMedium) {
  const sides = simplifiedSides(equation);
  const representative = new Map<string, ParsedSpecies>();
  for (const species of [...equation.reactants, ...equation.products]) representative.set(speciesKey(species), species);
  const remainingSpecies = [...new Set([...sides.reactants.keys(), ...sides.products.keys()])]
    .map((key) => representative.get(key)!)
    .filter((species) => !species.electron);
  const forbidden = new Set<string>();
  const forbid = (elements: Record<string, number>, charge: number, label: string) => {
    if (remainingSpecies.some((species) => sameComposition(species, elements, charge))) forbidden.add(label);
  };
  if (medium === 'alkaline') {
    forbid({ H: 1 }, 1, 'H^+');
    forbid({ H: 3, O: 1 }, 1, 'H3O^+');
  } else if (medium === 'acidic') {
    forbid({ H: 1, O: 1 }, -1, 'OH^-');
  } else if (medium === 'molten') {
    forbid({ H: 1 }, 1, 'H^+');
    forbid({ H: 3, O: 1 }, 1, 'H3O^+');
    forbid({ H: 1, O: 1 }, -1, 'OH^-');
    forbid({ H: 2, O: 1 }, 0, 'H2O');
  }
  const forbiddenSpecies = [...forbidden].sort((left, right) => left.localeCompare(right));
  return { matches: forbiddenSpecies.length === 0, forbiddenSpecies };
}

export function analyzeEquation(source: string, options: AnalyzeEquationOptions): EquationAnalysis {
  let parsed: ParsedEquation;
  try {
    parsed = parseEquation(source);
  } catch (error) {
    const failure = error instanceof EquationParseError
      ? error
      : new EquationParseError(error instanceof Error ? error.message : String(error), 0);
    return {
      status: 'parse-error',
      grammarVersion: equationGrammarVersion,
      source,
      error: { message: failure.message, position: failure.position },
    };
  }

  const reactants = totalsForSide(parsed.reactants);
  const products = totalsForSide(parsed.products);
  const difference = Object.fromEntries(
    [...new Set([...reactants.elements.keys(), ...products.elements.keys()])]
      .sort((left, right) => left.localeCompare(right))
      .map((element) => [element, (products.elements.get(element) ?? 0) - (reactants.elements.get(element) ?? 0)])
      .filter(([, value]) => value !== 0),
  ) as Record<string, number>;
  const actualSide = actualElectronSide(reactants.electrons, products.electrons);
  const expectedSide = options.kind === 'overall' ? 'none' : options.expectedElectronSide;
  const electronBalanced = expectedSide === 'none'
    ? actualSide === 'none'
    : actualSide === expectedSide;
  const medium = mediumCheck(parsed, options.medium);
  const conservation = {
    atoms: { balanced: Object.keys(difference).length === 0, difference },
    charge: {
      balanced: reactants.charge === products.charge,
      reactants: reactants.charge,
      products: products.charge,
    },
    electrons: {
      balanced: electronBalanced,
      actualSide,
      expectedSide,
      count: actualSide === 'reactant'
        ? reactants.electrons
        : actualSide === 'product'
          ? products.electrons
          : 0,
      reactants: reactants.electrons,
      products: products.electrons,
    },
  };
  return {
    status: 'parsed',
    grammarVersion: equationGrammarVersion,
    source,
    parsed,
    canonical: canonicalizeParsedEquation(parsed),
    conservation,
    medium,
    valid: conservation.atoms.balanced
      && conservation.charge.balanced
      && conservation.electrons.balanced
      && medium.matches,
  };
}

function speciesSignature(parsed: ParsedEquation) {
  const sides = simplifiedSides(parsed);
  const serialize = (side: Map<string, number>) => [...side.keys()].sort().join('|');
  return `${serialize(sides.reactants)} -> ${serialize(sides.products)}`;
}

export function scoreEquation(source: string, expected: EquationSet): EquationScore {
  const kind = expected.electrode === 'overall' ? 'overall' : 'half';
  const analysis = analyzeEquation(source, {
    kind,
    medium: expected.medium,
    expectedElectronSide: expected.expectedElectronSide,
  });
  if (analysis.status === 'parse-error') {
    return {
      outcome: 'miss',
      ruleId: 'equation-parse-miss',
      analysis,
      nodeDecisions: [{ nodeId: 'P6', outcome: 'miss', reasons: [analysis.error.message] }],
    };
  }

  const accepted = expected.accepted.map((candidate) => {
    const parsed = parseEquation(candidate);
    return {
      canonical: canonicalizeParsedEquation(parsed),
      signature: speciesSignature(parsed),
    };
  });
  const exact = accepted.find((candidate) => candidate.canonical === analysis.canonical);
  if (analysis.valid && exact) {
    return {
      outcome: 'hit',
      ruleId: 'equation-hit',
      analysis,
      matchedCanonical: exact.canonical,
      nodeDecisions: [
        { nodeId: 'P3', outcome: 'hit', reasons: ['medium matches the configured case'] },
        { nodeId: kind === 'overall' ? 'P7' : 'P6', outcome: 'hit', reasons: ['canonical form matches an accepted equation'] },
      ],
    };
  }

  const conserved = analysis.conservation.atoms.balanced
    && analysis.conservation.charge.balanced
    && analysis.conservation.electrons.balanced;
  if (conserved && !analysis.medium.matches) {
    return {
      outcome: 'partial',
      ruleId: 'equation-medium-partial',
      analysis,
      nodeDecisions: [
        {
          nodeId: 'P3',
          outcome: 'partial',
          reasons: [`forbidden in ${expected.medium}: ${analysis.medium.forbiddenSpecies.join(', ')}`],
        },
        { nodeId: 'P6', outcome: 'hit', reasons: ['atom, charge, and electron checks pass'] },
      ],
    };
  }

  const failedConservationChecks = [
    analysis.conservation.atoms.balanced,
    analysis.conservation.charge.balanced,
    analysis.conservation.electrons.balanced,
  ].filter((balanced) => !balanced).length;
  const nearSignature = accepted.some(
    (candidate) => candidate.signature === speciesSignature(analysis.parsed),
  );
  if (analysis.medium.matches && nearSignature && failedConservationChecks === 1) {
    return {
      outcome: 'partial',
      ruleId: 'equation-balance-partial',
      analysis,
      nodeDecisions: [
        { nodeId: 'P3', outcome: 'hit', reasons: ['species and medium match the configured case'] },
        { nodeId: 'P6', outcome: 'partial', reasons: ['one conservation check failed'] },
      ],
    };
  }

  return {
    outcome: 'miss',
    ruleId: 'equation-miss',
    analysis,
    nodeDecisions: [
      {
        nodeId: 'P3',
        outcome: analysis.medium.matches ? 'miss' : 'partial',
        reasons: analysis.medium.matches
          ? ['products do not match the configured case']
          : [`forbidden in ${expected.medium}: ${analysis.medium.forbiddenSpecies.join(', ')}`],
      },
      { nodeId: 'P6', outcome: 'miss', reasons: ['equation is not an accepted conserved equivalent'] },
    ],
  };
}

export interface HalfReactionPairValidation {
  balanced: boolean;
  electronCount: number;
  multipliers: [number, number];
}

export function validateHalfReactionPair(
  oxidation: string,
  reduction: string,
): HalfReactionPairValidation {
  const left = analyzeEquation(oxidation, {
    kind: 'half',
    medium: 'neutral',
    expectedElectronSide: 'product',
  });
  const right = analyzeEquation(reduction, {
    kind: 'half',
    medium: 'neutral',
    expectedElectronSide: 'reactant',
  });
  if (left.status === 'parse-error') throw new EquationParseError(left.error.message, left.error.position);
  if (right.status === 'parse-error') throw new EquationParseError(right.error.message, right.error.position);
  const leftCount = left.conservation.electrons.count;
  const rightCount = right.conservation.electrons.count;
  if (leftCount === 0 || rightCount === 0) {
    return { balanced: false, electronCount: 0, multipliers: [0, 0] };
  }
  const divisor = greatestCommonDivisor(leftCount, rightCount);
  const leastCommonMultiple = (leftCount / divisor) * rightCount;
  return {
    balanced: left.valid && right.valid && leftCount === rightCount,
    electronCount: leastCommonMultiple,
    multipliers: [leastCommonMultiple / leftCount, leastCommonMultiple / rightCount],
  };
}
