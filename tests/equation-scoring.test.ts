import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  EquationParseError,
  analyzeEquation,
  canonicalizeEquation,
  parseEquation,
  scoreEquation,
  tokenizeEquation,
  validateHalfReactionPair,
} from '../shared/chemistry/equation';

async function equationSet(caseId: string, equationId: string) {
  const config = await loadAllConfig(process.cwd());
  const trainingCase = config.cases.find((entry) => entry.id === caseId)!;
  return trainingCase.equationSets.find((entry) => entry.id === equationId)!;
}

describe('electrode equation grammar and scoring', () => {
  it('tokenizes Unicode charges, electrons, arrows, groups, and states with source offsets', () => {
    const tokens = tokenizeEquation('[Al(OH)4]⁻ + 3e⁻ → Al(s) + 4OH⁻');

    expect(tokens.map((token) => token.kind)).toEqual(expect.arrayContaining([
      'bracket-open',
      'element',
      'number',
      'charge-sign',
      'electron',
      'arrow',
      'state',
    ]));
    expect(tokens.every((token) => token.end > token.start)).toBe(true);
  });

  it('parses nested groups, implicit monatomic charges, polyatomic +1 charges, and optional states', () => {
    const aluminum = parseEquation('Al + 4OH^- -> [Al(OH)4]^- + 3e^-');
    const ammonium = parseEquation('NH4+ -> NH3 + H+');
    const copper = parseEquation('Cu2+(aq) + 2e- = Cu(s)');

    expect(aluminum.products[0]).toMatchObject({
      coefficient: 1,
      elements: { Al: 1, H: 4, O: 4 },
      charge: -1,
    });
    expect(ammonium.reactants[0]).toMatchObject({ elements: { H: 4, N: 1 }, charge: 1 });
    expect(copper.reactants[0]).toMatchObject({ elements: { Cu: 1 }, charge: 2, state: 'aq' });
  });

  it('reports a precise parse position instead of guessing malformed input', () => {
    expect(() => parseEquation('Zn + -> Zn^2+')).toThrow(EquationParseError);
    try {
      parseEquation('Zn + -> Zn^2+');
    } catch (error) {
      expect(error).toMatchObject({ position: 3 });
    }
  });

  it('canonicalizes order, whole-equation multiples, arrow style, Unicode, and states equally', () => {
    const expected = canonicalizeEquation('Cu^2+ + 2e^- -> Cu');
    const variants = [
      '2e^- + Cu^2+ = Cu(s)',
      '2Cu²⁺ + 4e⁻ → 2Cu',
      '4e- + 2Cu2+ ⇌ 2Cu',
    ];

    for (const variant of variants) {
      expect(canonicalizeEquation(variant)).toBe(expected);
    }
    expect(canonicalizeEquation('Cu -> Cu^2+ + 2e^-')).not.toBe(expected);
  });

  it('checks atom, charge, and expected electron-side conservation independently', () => {
    const valid = analyzeEquation('Zn -> Zn^2+ + 2e^-', {
      kind: 'half',
      medium: 'neutral',
      expectedElectronSide: 'product',
    });
    const wrongCoefficient = analyzeEquation('Zn -> Zn^2+ + e^-', {
      kind: 'half',
      medium: 'neutral',
      expectedElectronSide: 'product',
    });
    const wrongDirection = analyzeEquation('Zn^2+ + 2e^- -> Zn', {
      kind: 'half',
      medium: 'neutral',
      expectedElectronSide: 'product',
    });

    expect(valid).toMatchObject({
      status: 'parsed',
      valid: true,
      conservation: {
        atoms: { balanced: true },
        charge: { balanced: true },
        electrons: { balanced: true, actualSide: 'product', count: 2 },
      },
    });
    expect(wrongCoefficient.status === 'parsed' && wrongCoefficient.conservation.charge.balanced).toBe(false);
    expect(wrongDirection.status === 'parsed' && wrongDirection.conservation.electrons.balanced).toBe(false);
  });

  it('rejects acidic balancing species in alkaline medium even when all conservation checks pass', () => {
    const result = analyzeEquation('O2 + 4H^+ + 4e^- -> 2H2O', {
      kind: 'half',
      medium: 'alkaline',
      expectedElectronSide: 'reactant',
    });

    expect(result).toMatchObject({
      status: 'parsed',
      conservation: {
        atoms: { balanced: true },
        charge: { balanced: true },
        electrons: { balanced: true },
      },
      medium: { matches: false, forbiddenSpecies: ['H^+'] },
      valid: false,
    });
  });

  it('accepts both frozen alkaline aluminum-air negative-electrode forms', async () => {
    const expected = await equationSet('aluminum-air', 'aluminum-negative');

    expect(scoreEquation('Al + 4OH^- = AlO2^- + 2H2O + 3e^-', expected).outcome).toBe('hit');
    expect(scoreEquation('Al + 4OH^- -> 3e^- + [Al(OH)4]^-', expected).outcome).toBe('hit');
  });

  it('parses and accepts every configured case equivalence corpus entry', async () => {
    const config = await loadAllConfig(process.cwd());

    for (const trainingCase of config.cases) {
      for (const expected of trainingCase.equationSets) {
        for (const accepted of expected.accepted) {
          expect(scoreEquation(accepted, expected), `${trainingCase.id}/${expected.id}: ${accepted}`)
            .toMatchObject({ outcome: 'hit', ruleId: 'equation-hit' });
        }
      }
    }
  });

  it('scores a conserved wrong-medium equation partial and traces it to P3', async () => {
    const expected = await equationSet('aluminum-air', 'oxygen-positive');
    const result = scoreEquation('O2 + 4H^+ + 4e^- -> 2H2O', expected);

    expect(result).toMatchObject({
      outcome: 'partial',
      ruleId: 'equation-medium-partial',
      nodeDecisions: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'P3', outcome: 'partial' }),
      ]),
    });
  });

  it('scores a one-coefficient near miss partial but rejects wrong species and parse failures', async () => {
    const expected = await equationSet('zinc-copper', 'copper-positive');
    const near = scoreEquation('Cu^2+ + e^- -> Cu', expected);
    const wrong = scoreEquation('Cu^2+ + 2e^- -> Zn', expected);
    const malformed = scoreEquation('Cu^2+ + -> Cu', expected);

    expect(near).toMatchObject({ outcome: 'partial', ruleId: 'equation-balance-partial' });
    expect(wrong).toMatchObject({ outcome: 'miss', ruleId: 'equation-miss' });
    expect(malformed).toMatchObject({
      outcome: 'miss',
      ruleId: 'equation-parse-miss',
      analysis: { status: 'parse-error' },
    });
  });

  it('requires a total equation to be conserved and electron-free', () => {
    const valid = analyzeEquation('Zn + Cu^2+ -> Zn^2+ + Cu', {
      kind: 'overall',
      medium: 'neutral',
      expectedElectronSide: 'none',
    });
    const invalid = analyzeEquation('Zn + Cu^2+ -> Zn^2+ + Cu + e^-', {
      kind: 'overall',
      medium: 'neutral',
      expectedElectronSide: 'none',
    });

    expect(valid.status === 'parsed' && valid.valid).toBe(true);
    expect(invalid.status === 'parsed' && invalid.conservation.electrons.balanced).toBe(false);
  });

  it('validates paired electron counts and reports the least multipliers needed', () => {
    const zincCopper = validateHalfReactionPair(
      'Zn -> Zn^2+ + 2e^-',
      'Cu^2+ + 2e^- -> Cu',
    );
    const hydrogenOxygen = validateHalfReactionPair(
      'H2 -> 2H^+ + 2e^-',
      'O2 + 4H^+ + 4e^- -> 2H2O',
    );

    expect(zincCopper).toMatchObject({ balanced: true, electronCount: 2, multipliers: [1, 1] });
    expect(hydrogenOxygen).toMatchObject({
      balanced: false,
      electronCount: 4,
      multipliers: [2, 1],
    });
  });

  it('is invariant under every tested species permutation and positive whole-number scale', async () => {
    const expected = await equationSet('aluminum-air', 'oxygen-positive');
    const variants = [
      'O2 + 2H2O + 4e^- -> 4OH^-',
      '4e^- + O2 + 2H2O -> 4OH^-',
      '2H2O + 4e^- + O2 -> 4OH^-',
      '2O2 + 4H2O + 8e^- -> 8OH^-',
    ];

    const canonical = variants.map((variant) => scoreEquation(variant, expected));
    expect(canonical.every((result) => result.outcome === 'hit')).toBe(true);
    expect(new Set(
      canonical.map((result) => result.analysis.status === 'parsed' && result.analysis.canonical),
    ).size).toBe(1);
  });
});
