// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { HandDrawingPanel } from '../src/features/pretest/HandDrawingPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('hand drawing easter egg', () => {
  it('sends only image data to the isolated vision reviewer and renders natural-language feedback', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,hand-drawing');
    const reviewDrawing = vi.fn(async () => '路径表达清楚，再检查阴阳离子的方向。');
    render(<HandDrawingPanel onReview={reviewDrawing} onFinish={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '提交手绘点评' }));

    expect(reviewDrawing).toHaveBeenCalledWith('hand-drawing');
    expect(await screen.findByText('路径表达清楚，再检查阴阳离子的方向。')).toBeInTheDocument();
    expect(screen.queryByText(/hit|partial|miss/i)).not.toBeInTheDocument();
  });

  it('keeps drawing workflow configuration on the server and marks mock feedback', async () => {
    const apiToken = 'm2-hand-drawing-test';
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      apiToken,
    });
    const response = await app.request('/api/drawing/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lq-api-token': apiToken },
      body: JSON.stringify({ imageData: 'hand-drawing' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      feedback: expect.stringContaining('演示占位'),
    });
  });
});
