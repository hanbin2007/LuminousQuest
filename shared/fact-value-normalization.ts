interface NormalizedUnit {
  character: string;
  start: number;
  end: number;
}

function basicUnits(value: string) {
  const units: NormalizedUnit[] = [];
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const source = String.fromCodePoint(point);
    const end = index + source.length;
    for (const character of source.normalize('NFKC').toLocaleLowerCase('en-US')) {
      if (!/\s/u.test(character)) units.push({ character, start: index, end });
    }
    index = end;
  }
  return units;
}

function normalizedTypoEntries(commonTypos: Record<string, string>) {
  return Object.entries(commonTypos)
    .map(([source, replacement]) => ({
      source: basicUnits(source).map((unit) => unit.character).join(''),
      replacement: basicUnits(replacement).map((unit) => unit.character).join(''),
    }))
    .filter((entry) => entry.source.length > 0 && entry.replacement.length > 0)
    .sort((left, right) => right.source.length - left.source.length);
}

export function normalizeWithPositions(value: string, commonTypos: Record<string, string>) {
  const input = basicUnits(value);
  const typoEntries = normalizedTypoEntries(commonTypos);
  const output: NormalizedUnit[] = [];
  for (let index = 0; index < input.length;) {
    const remaining = input.slice(index).map((unit) => unit.character).join('');
    const typo = typoEntries.find((entry) => remaining.startsWith(entry.source));
    if (!typo) {
      output.push(input[index]);
      index += 1;
      continue;
    }
    const matched = input.slice(index, index + [...typo.source].length);
    const start = matched[0].start;
    const end = matched.at(-1)!.end;
    for (const character of typo.replacement) output.push({ character, start, end });
    index += matched.length;
  }
  return output;
}

export function normalizeComparisonText(value: string, commonTypos: Record<string, string>) {
  return normalizeWithPositions(value, commonTypos)
    .map((unit) => unit.character)
    .join('');
}

export function factValueAliases(
  value: string,
  aliases: Record<string, string[]>,
  commonTypos: Record<string, string>,
) {
  const configured = aliases[value] ?? [];
  return [...new Set([value, ...configured]
    .map((entry) => normalizeComparisonText(entry, commonTypos))
    .filter((entry) => entry.length > 0))];
}
