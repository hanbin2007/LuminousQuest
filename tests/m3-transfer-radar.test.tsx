// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TransferRadarComparison } from '../src/features/training/TransferRadarComparison';
import type { TransferComparison } from '../src/features/training/transfer-comparison';

afterEach(cleanup);

describe('transfer radar presentation', () => {
  it('shows diagnosis-compatible threshold levels and explicit unassessed state', () => {
    const result = (ratio: number | null, level: 'unassessed' | 'weak' | 'developing' | 'mastered') => ({
      weightedEarned: ratio ?? 0,
      assessedWeight: ratio === null ? 0 : 1,
      ratio,
      level,
      assessedNodeIds: ratio === null ? [] : ['D1'],
      unassessedNodeIds: ratio === null ? ['D1'] : [],
    });
    const comparison: TransferComparison = {
      transferCaseId: 'transfer',
      commonNodeIds: ['D1', 'P1', 'E1'],
      dimensions: [
        { dimensionId: 'device', label: '装置', commonNodeIds: ['D1'], pretest: result(0.5, 'weak'), transfer: result(1, 'mastered') },
        { dimensionId: 'principle', label: '原理', commonNodeIds: ['P1'], pretest: result(0.8, 'developing'), transfer: result(null, 'unassessed') },
        { dimensionId: 'energy', label: '能量', commonNodeIds: ['E1'], pretest: result(null, 'unassessed'), transfer: result(null, 'unassessed') },
      ],
    };

    render(<TransferRadarComparison comparison={comparison} />);

    expect(screen.getByText('50% · 薄弱')).toHaveAttribute('data-level', 'weak');
    expect(screen.getByText('100% · 掌握')).toHaveAttribute('data-level', 'mastered');
    expect(screen.getByText('80% · 发展中')).toHaveAttribute('data-level', 'developing');
    expect(screen.getAllByText('未测').length).toBeGreaterThan(0);
  });
});
