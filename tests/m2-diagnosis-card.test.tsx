// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AnnotationCard } from '../src/features/diagnosis/AnnotationCard';
import { radarSeriesValues } from '../src/features/diagnosis/DiagnosisRadar';

afterEach(cleanup);

describe('diagnostic annotation card', () => {
  it('renders the fixed evidence structure and highlighted student quote for a miss', () => {
    render(
      <AnnotationCard
        dimensionLabel="原理"
        nodeId="P4"
        rubricId="rubric-p4"
        status="miss"
        correct="识别到了外电路。"
        incorrect="电子流向写反。"
        next="从失电子场所沿外电路重新追踪。"
        quote="电子由铜极流向锌极"
      />,
    );

    expect(screen.getByText('答对了什么')).toBeInTheDocument();
    expect(screen.getByText('错在哪里')).toBeInTheDocument();
    expect(screen.getByText('下一步想什么')).toBeInTheDocument();
    expect(screen.getByText('电子由铜极流向锌极').tagName).toBe('MARK');
    expect(screen.getByTestId('annotation-P4')).toHaveAttribute('data-status', 'miss');
  });

  it('keeps unassessed evidence visually and semantically separate from a miss', () => {
    render(
      <AnnotationCard
        dimensionLabel="能量"
        nodeId="E2"
        rubricId="rubric-e2"
        status="unassessed"
        correct="尚无可引用证据。"
        incorrect="本项未测到，不能视为错误。"
        next="完成对应作答后再判断。"
      />,
    );

    const card = screen.getByTestId('annotation-E2');
    expect(card).toHaveAttribute('data-status', 'unassessed');
    expect(card).not.toHaveAttribute('data-status', 'miss');
    expect(screen.getByText('本项未测到，不能视为错误。')).toBeInTheDocument();
  });

  it('renders needs-review as an answered fourth state', () => {
    render(
      <AnnotationCard
        dimensionLabel="原理"
        nodeId="P4"
        rubricId="rubric-p4"
        status="needs-review"
        correct="已作答，待教师复核。"
        incorrect="当前结果尚未完成自动判定，不能视为错误或未作答。"
        next="等待教师复核本次证据。"
      />,
    );

    const card = screen.getByTestId('annotation-P4');
    expect(card).toHaveAttribute('data-status', 'needs-review');
    expect(screen.getByText('已作答，待教师复核')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('本项未测到');
  });

  it('keeps unassessed radar dimensions missing instead of converting them to zero', () => {
    expect(radarSeriesValues([
      { id: 'device', label: '装置', value: 0.75 },
      { id: 'principle', label: '原理', value: null },
      { id: 'energy', label: '能量', value: 0 },
    ])).toEqual([75, '-', 0]);
  });
});
