import type { CaseConfig, RubricsConfig } from '../config/schemas';

export const equationGrammarVersion = 'equation-grammar.v2';
export const equationScoringEngineVersion = 'equation-scoring.v3';

const maximumSourceLength = 2_048;
const maximumNumericDigits = 6;
const maximumNumericValue = 999_999;
const maximumFormulaNesting = 8;
const maximumTermsPerSide = 64;
const maximumAtomCount = 1_000_000_000;

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
  arrow: '->' | '=' | '⇌';
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

export interface EquationUnanswered {
  status: 'unanswered';
  grammarVersion: typeof equationGrammarVersion;
  source: string;
  reason: string;
}

export type AnalyzedEquation = ParsedEquationAnalysis | EquationParseFailure;
export type EquationAnalysis = AnalyzedEquation | EquationUnanswered;

export interface EquationScoreNodeDecision {
  nodeId: string;
  outcome: 'hit' | 'partial' | 'miss' | 'unanswered';
  errorIds: string[];
  reasons: string[];
}

export interface EquationScore {
  outcome: 'hit' | 'partial' | 'miss' | 'unanswered';
  ruleId:
    | 'equation-hit'
    | 'equation-medium-partial'
    | 'equation-balance-partial'
    | 'equation-policy-miss'
    | 'equation-unanswered'
    | 'equation-parse-miss'
    | 'equation-miss';
  analysis: EquationAnalysis;
  matchedCanonical?: string;
  nodeDecisions: EquationScoreNodeDecision[];
}

type EquationSet = CaseConfig['equationSets'][number];

export const knownIonIdentities: Readonly<Record<string, string>> = Object.freeze({
  'H|1': 'hydrogen',
  'H3O|1': 'hydronium',
  'NH4|1': 'ammonium',
  'OH|-1': 'hydroxide',
  'NO3|-1': 'nitrate',
  'NO2|-1': 'nitrite',
  'SO4|-2': 'sulfate',
  'SO3|-2': 'sulfite',
  'HSO4|-1': 'hydrogen-sulfate',
  'CO3|-2': 'carbonate',
  'HCO3|-1': 'hydrogen-carbonate',
  'PO4|-3': 'phosphate',
  'HPO4|-2': 'hydrogen-phosphate',
  'H2PO4|-1': 'dihydrogen-phosphate',
  'MnO4|-1': 'permanganate',
  'CrO4|-2': 'chromate',
  'Cr2O7|-2': 'dichromate',
  'CN|-1': 'cyanide',
  'SCN|-1': 'thiocyanate',
  'ClO|-1': 'hypochlorite',
  'ClO3|-1': 'chlorate',
  'AlO2|-1': 'aluminate',
});

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
    .replace(/→/g, '->');
  normalized = normalized.replace(/[⁰¹²³⁴-⁹]+[⁺⁻]/g, (value) => {
    const sign = value.at(-1) === '⁺' ? '+' : '-';
    const magnitude = [...value.slice(0, -1)].map((digit) => superscriptDigits[digit]).join('');
    return `^${magnitude}${sign}`;
  });
  normalized = normalized.replace(/[⁺⁻]/g, (value) => `^${value === '⁺' ? '+' : '-'}`);
  normalized = normalized.replace(/[₀-₉]/g, (value) => subscriptDigits[value]);
  const arrow = normalized.match(/->|=|⇌/);
  if (!arrow || arrow.index === undefined) return normalized;
  const left = normalized.slice(0, arrow.index);
  const right = normalized.slice(arrow.index + arrow[0].length);
  const subtraction = /^(.*?)\s+-\s+(\d*)\s*e(?:\^)?-\s*$/;
  const leftMatch = left.match(subtraction);
  if (leftMatch) {
    const coefficient = leftMatch[2] || '1';
    return `${leftMatch[1].trimEnd()} ${arrow[0]} ${right.trimStart()} + ${coefficient}e^-`;
  }
  const rightMatch = right.match(subtraction);
  if (rightMatch) {
    const coefficient = rightMatch[2] || '1';
    return `${left.trimEnd()} + ${coefficient}e^- ${arrow[0]} ${rightMatch[1].trimStart()}`;
  }
  return normalized;
}

export function tokenizeEquation(source: string): EquationToken[] {
  const normalized = normalizeEquationSource(source);
  if (normalized.length > maximumSourceLength) {
    throw new EquationParseError(`Equation exceeds source length limit ${maximumSourceLength}`, maximumSourceLength);
  }
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
    if (character === '⇌') {
      push('arrow', '⇌');
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
      if (number[0].length > maximumNumericDigits) {
        throw new EquationParseError('Numeric token exceeds safe digit limit', index);
      }
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
  const arrows: Array<{ index: number; value: '->' | '=' | '⇌'; length: number }> = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith('->', index)) {
      arrows.push({ index, value: '->', length: 2 });
      index += 1;
    } else if (source[index] === '=') {
      arrows.push({ index, value: '=', length: 1 });
    } else if (source[index] === '⇌') {
      arrows.push({ index, value: '⇌', length: 1 });
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
      if (terms.length >= maximumTermsPerSide) {
        throw new EquationParseError('Equation term count exceeds limit', baseOffset + index);
      }
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

function safePositiveInteger(source: string, offset: number, label: string) {
  if (source.length > maximumNumericDigits) {
    throw new EquationParseError(`${label} numeric length exceeds safe limit`, offset);
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximumNumericValue) {
    throw new EquationParseError(`${label} must be positive and within the safe numeric limit`, offset);
  }
  return value;
}

function safeAtomCount(value: number, offset: number) {
  if (!Number.isSafeInteger(value) || value > maximumAtomCount) {
    throw new EquationParseError('Formula atom count exceeds safe limit', offset);
  }
  return value;
}

function addElements(target: Map<string, number>, source: Map<string, number>, multiplier: number) {
  for (const [element, count] of source) {
    target.set(
      element,
      safeAtomCount((target.get(element) ?? 0) + count * multiplier, 0),
    );
  }
}

function parseFormula(formula: string, offset: number) {
  let index = 0;
  const parseSequence = (closing?: ')' | ']', depth = 0): Map<string, number> => {
    if (depth > maximumFormulaNesting) {
      throw new EquationParseError('Formula nesting exceeds limit', offset + index);
    }
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
        const group = parseSequence(expectedClosing, depth + 1);
        const multiplierMatch = formula.slice(index).match(/^\d+/);
        const multiplier = multiplierMatch
          ? safePositiveInteger(multiplierMatch[0], offset + index, 'Subscript')
          : 1;
        if (multiplierMatch) index += multiplierMatch[0].length;
        addElements(elements, group, multiplier);
        continue;
      }
      const element = formula.slice(index).match(/^[A-Z][a-z]?/);
      if (!element) throw new EquationParseError('Expected element or group', offset + index);
      parsedAny = true;
      index += element[0].length;
      const subscriptMatch = formula.slice(index).match(/^\d+/);
      const subscript = subscriptMatch
        ? safePositiveInteger(subscriptMatch[0], offset + index, 'Subscript')
        : 1;
      if (subscriptMatch) index += subscriptMatch[0].length;
      elements.set(
        element[0],
        safeAtomCount((elements.get(element[0]) ?? 0) + subscript, offset + index),
      );
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
    coefficient = safePositiveInteger(coefficientMatch[0], offset, 'Coefficient');
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
    const magnitude = explicitCharge[1] === ''
      ? 1
      : safePositiveInteger(
          explicitCharge[1],
          offset + body.length - explicitCharge[0].length + 1,
          'Charge magnitude',
        );
    charge = explicitCharge[2] === '+' ? magnitude : -magnitude;
    body = body.slice(0, -explicitCharge[0].length);
  } else {
    const implicitCharge = body.match(/([+-])$/);
    if (implicitCharge) {
      const sign = implicitCharge[1] === '+' ? 1 : -1;
      body = body.slice(0, -1);
      const monatomic = body.match(/^([A-Z][a-z]?)(\d+)$/);
      if (monatomic) {
        charge = sign * safePositiveInteger(monatomic[2], offset + monatomic[1].length, 'Charge magnitude');
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
  const ionIdentity = knownIonIdentities[`${species.formula}|${species.charge}`];
  if (ionIdentity) return `@ion:${ionIdentity}|${species.charge}`;
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

export function analyzeEquation(source: string, options: AnalyzeEquationOptions): AnalyzedEquation {
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

function isEquationNonResponse(source: string) {
  const normalized = source.trim().replace(/[。.!！?？]/g, '');
  return normalized.length === 0 || /^(不会|不知道|不会写|不清楚|放弃)$/u.test(normalized);
}

function notationPolicyIssues(
  analysis: ParsedEquationAnalysis,
  policy?: RubricsConfig['policy'],
) {
  if (!policy) return [];
  const issues: string[] = [];
  if (analysis.parsed.arrow === '=' && !policy.equation.acceptEqualsSign) {
    issues.push('equals sign is disabled by equation policy');
  }
  if (policy.equation.requireEquilibriumArrow && analysis.parsed.arrow !== '⇌') {
    issues.push('equilibrium arrow is required by equation policy');
  }
  if (
    policy.equation.requireStates
    && [...analysis.parsed.reactants, ...analysis.parsed.products]
      .some((species) => !species.electron && species.state === undefined)
  ) {
    issues.push('physical states are required by equation policy');
  }
  return issues;
}

function mediumErrorIds(analysis: ParsedEquationAnalysis) {
  if (analysis.medium.matches) return [];
  const ids = ['P3-M1'];
  if (analysis.medium.forbiddenSpecies.some((species) => species === 'H^+' || species === 'H3O^+')) {
    ids.push('P3-M2');
  }
  return ids;
}

function halfReactionBalanceErrorIds(
  analysis: ParsedEquationAnalysis,
  expected: EquationSet,
) {
  const ids: string[] = [];
  if (!analysis.conservation.atoms.balanced || !analysis.conservation.charge.balanced) {
    ids.push('P6-M1');
  }
  const acceptedElectronCounts = new Set(expected.accepted.map((candidate) => {
    const parsed = analyzeEquation(candidate, {
      kind: 'half',
      medium: expected.medium,
      expectedElectronSide: expected.expectedElectronSide,
    });
    return parsed.status === 'parsed' ? parsed.conservation.electrons.count : -1;
  }));
  if (
    !analysis.conservation.electrons.balanced
    || !acceptedElectronCounts.has(analysis.conservation.electrons.count)
  ) ids.push('P6-M2');
  return ids;
}

function balanceErrorIds(
  analysis: ParsedEquationAnalysis,
  expected: EquationSet,
  kind: 'half' | 'overall',
) {
  if (kind === 'half') return halfReactionBalanceErrorIds(analysis, expected);
  return analysis.conservation.electrons.count > 0 ? ['P7-M2'] : ['P7-M1'];
}

export function scoreEquation(
  source: string,
  expected: EquationSet,
  policy?: RubricsConfig['policy'],
): EquationScore {
  const kind = expected.electrode === 'overall' ? 'overall' : 'half';
  const balanceNodeId = kind === 'overall' ? 'P7' : 'P6';
  if (isEquationNonResponse(source)) {
    const configuredStatus = policy?.nonResponse.status ?? 'unanswered';
    return {
      outcome: configuredStatus,
      ruleId: configuredStatus === 'unanswered' ? 'equation-unanswered' : 'equation-miss',
      analysis: {
        status: 'unanswered',
        grammarVersion: equationGrammarVersion,
        source,
        reason: 'blank or explicit non-answer',
      },
      nodeDecisions: [{
        nodeId: balanceNodeId,
        outcome: configuredStatus,
        errorIds: [],
        reasons: ['blank or explicit non-answer'],
      }],
    };
  }
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
      nodeDecisions: [{
        nodeId: balanceNodeId,
        outcome: 'miss',
        errorIds: [kind === 'overall' ? 'P7-M1' : 'P6-M1'],
        reasons: [analysis.error.message],
      }],
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
  const notationIssues = notationPolicyIssues(analysis, policy);
  const productDecision = (
    outcome: 'hit' | 'partial' | 'miss',
    errorIds: string[],
    reasons: string[],
  ): EquationScoreNodeDecision[] => kind === 'overall'
    ? []
    : [{ nodeId: 'P3', outcome, errorIds, reasons }];
  if (analysis.valid && exact && notationIssues.length === 0) {
    return {
      outcome: 'hit',
      ruleId: 'equation-hit',
      analysis,
      matchedCanonical: exact.canonical,
      nodeDecisions: [
        ...productDecision('hit', [], ['medium matches the configured case']),
        {
          nodeId: balanceNodeId,
          outcome: 'hit',
          errorIds: [],
          reasons: ['canonical form matches an accepted equation'],
        },
      ],
    };
  }

  if (analysis.valid && exact && notationIssues.length > 0) {
    return {
      outcome: 'miss',
      ruleId: 'equation-policy-miss',
      analysis,
      matchedCanonical: exact.canonical,
      nodeDecisions: [
        ...productDecision('hit', [], ['species and medium match the configured case']),
        { nodeId: balanceNodeId, outcome: 'miss', errorIds: [], reasons: notationIssues },
      ],
    };
  }

  const conserved = analysis.conservation.atoms.balanced
    && analysis.conservation.charge.balanced
    && analysis.conservation.electrons.balanced;
  const crossMediumMatch = (expected.crossMediumAccepted ?? []).some((family) => {
    const crossAnalysis = analyzeEquation(source, {
      kind,
      medium: family.medium,
      expectedElectronSide: expected.expectedElectronSide,
    });
    if (crossAnalysis.status !== 'parsed' || !crossAnalysis.valid) return false;
    return family.accepted.some((candidate) =>
      canonicalizeEquation(candidate) === crossAnalysis.canonical);
  });
  if (conserved && !analysis.medium.matches && crossMediumMatch) {
    const mediumOutcome = policy?.equation.mediumMismatchOutcome ?? 'partial';
    const feedbackNodeId = policy?.equation.feedbackNodeId ?? 'P3';
    return {
      outcome: mediumOutcome,
      ruleId: 'equation-medium-partial',
      analysis,
      nodeDecisions: [
        ...(kind === 'overall' ? [] : [{
          nodeId: feedbackNodeId,
          outcome: mediumOutcome,
          errorIds: mediumErrorIds(analysis),
          reasons: [`forbidden in ${expected.medium}: ${analysis.medium.forbiddenSpecies.join(', ')}`],
        }]),
        {
          nodeId: balanceNodeId,
          outcome: kind === 'half' ? mediumOutcome : 'hit',
          errorIds: kind === 'half' ? ['P6-M3'] : [],
          reasons: kind === 'half'
            ? [`conserved equation uses species forbidden in ${expected.medium}`]
            : ['atom, charge, and electron checks pass'],
        },
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
        ...productDecision('hit', [], ['species and medium match the configured case']),
        {
          nodeId: balanceNodeId,
          outcome: 'partial',
          errorIds: balanceErrorIds(analysis, expected, kind),
          reasons: ['one conservation check failed'],
        },
      ],
    };
  }

  return {
    outcome: 'miss',
    ruleId: 'equation-miss',
    analysis,
    nodeDecisions: [
      ...productDecision(
        'miss',
        analysis.medium.matches ? ['P3-M3'] : mediumErrorIds(analysis),
        ['products or medium do not match a configured target-reaction family'],
      ),
      {
        nodeId: balanceNodeId,
        outcome: 'miss',
        errorIds: balanceErrorIds(analysis, expected, kind),
        reasons: ['equation is not an accepted conserved equivalent'],
      },
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
  medium: EquationMedium = 'neutral',
): HalfReactionPairValidation {
  const left = analyzeEquation(oxidation, {
    kind: 'half',
    medium,
    expectedElectronSide: 'product',
  });
  const right = analyzeEquation(reduction, {
    kind: 'half',
    medium,
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

export function combineHalfReactionsCanonical(
  oxidation: string,
  reduction: string,
  medium: EquationMedium,
) {
  const pair = validateHalfReactionPair(oxidation, reduction, medium);
  if (pair.electronCount === 0) {
    throw new Error('Half reactions must contain electrons on opposite sides');
  }
  const left = analyzeEquation(oxidation, {
    kind: 'half',
    medium,
    expectedElectronSide: 'product',
  });
  const right = analyzeEquation(reduction, {
    kind: 'half',
    medium,
    expectedElectronSide: 'reactant',
  });
  if (left.status !== 'parsed' || right.status !== 'parsed' || !left.valid || !right.valid) {
    throw new Error(`Half reactions must both be valid in ${medium} medium`);
  }
  const scale = (species: readonly ParsedSpecies[], multiplier: number) =>
    species.map((entry) => ({ ...entry, coefficient: entry.coefficient * multiplier }));
  const combined: ParsedEquation = {
    source: `${oxidation} + ${reduction}`,
    normalizedSource: `${left.parsed.normalizedSource} + ${right.parsed.normalizedSource}`,
    arrow: '->',
    reactants: [
      ...scale(left.parsed.reactants, pair.multipliers[0]),
      ...scale(right.parsed.reactants, pair.multipliers[1]),
    ],
    products: [
      ...scale(left.parsed.products, pair.multipliers[0]),
      ...scale(right.parsed.products, pair.multipliers[1]),
    ],
  };
  return {
    canonical: canonicalizeParsedEquation(combined),
    multipliers: pair.multipliers,
    electronCount: pair.electronCount,
  };
}
