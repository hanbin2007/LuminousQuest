import { describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import {
  lanAccessUrls,
  parseLaunchOptions,
} from '../server/runtime/launch-options';
import { serveOnHost } from '../server/runtime/serve-on-loopback';

describe('M4 LAN mode', () => {
  it('keeps loopback as the default and binds all interfaces only for --lan', () => {
    expect(parseLaunchOptions([])).toEqual({
      lan: false,
      lockDemo: false,
      hostname: '127.0.0.1',
    });
    expect(parseLaunchOptions(['--lan'])).toEqual({
      lan: true,
      lockDemo: false,
      hostname: '0.0.0.0',
    });
    expect(parseLaunchOptions(['--lock-demo'])).toEqual({
      lan: false,
      lockDemo: true,
      hostname: '127.0.0.1',
    });
    expect(parseLaunchOptions(['--lan', '--lock-demo'])).toEqual({
      lan: true,
      lockDemo: true,
      hostname: '0.0.0.0',
    });
    expect(() => parseLaunchOptions(['--unknown'])).toThrow(/unknown argument/i);
  });

  it('passes the explicit LAN hostname to the server implementation', async () => {
    const close = vi.fn();
    const removeListener = vi.fn();
    const once = vi.fn();
    const serveImplementation = vi.fn((options: any, callback: (info: { port: number }) => void) => {
      const server = { close, removeListener, once };
      queueMicrotask(() => callback({ port: options.port }));
      return server;
    });

    const started = await serveOnHost({
      fetch: () => new Response('ok'),
      hostname: '0.0.0.0',
      preferredPort: 4173,
      attempts: 0,
      serveImplementation: serveImplementation as any,
    });

    expect(started.port).toBe(4173);
    expect(serveImplementation).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '0.0.0.0', port: 4173 }),
      expect.any(Function),
    );
  });

  it('requires the printed LAN access token before exposing UI or API routes', async () => {
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: `${process.cwd()}/dist/client`,
      accessToken: 'lan-secret-token',
      apiToken: 'api-token',
      workflow: { executionMode: 'development', provider: 'mock', model: 'mock-v1' },
    });

    expect((await app.request('/api/runtime')).status).toBe(401);
    expect((await app.request('/?access_token=wrong')).status).toBe(401);

    const admitted = await app.request('/?access_token=lan-secret-token');
    expect(admitted.status).toBe(302);
    expect(admitted.headers.get('location')).toBe('/');
    const cookie = admitted.headers.get('set-cookie');
    expect(cookie).toMatch(/lq_lan_access=.*HttpOnly.*SameSite=Strict/i);

    const state = await app.request('/api/runtime', { headers: { cookie: cookie!.split(';')[0] } });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ executionMode: 'development', testNavigation: false });
  });

  it('prints token-bearing URLs only for private non-loopback IPv4 addresses', () => {
    expect(lanAccessUrls(4173, 'abc123', [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '192.168.1.8', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ])).toEqual(['http://192.168.1.8:4173/?access_token=abc123']);
  });
});
