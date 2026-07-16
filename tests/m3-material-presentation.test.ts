import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  mediumLabel,
  visibleCaseMaterials,
} from '../src/features/training/materials';

describe('configured training material presentation', () => {
  it('maps every configured medium to Chinese display copy', () => {
    expect(mediumLabel('acidic')).toBe('酸性介质');
    expect(mediumLabel('alkaline')).toBe('碱性介质');
    expect(mediumLabel('neutral')).toBe('中性介质');
    expect(mediumLabel('molten')).toBe('熔融');
  });

  it('reveals a cross-section only after all configured nodes complete', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'aluminum-air')!;

    expect(visibleCaseMaterials(trainingCase, [])).toHaveLength(1);
    expect(visibleCaseMaterials(trainingCase, ['P2'])).toHaveLength(1);
    expect(visibleCaseMaterials(trainingCase, ['P3', 'P2']).map((entry) => entry.kind))
      .toEqual(['apparatus-diagram', 'cross-section']);
  });
});
