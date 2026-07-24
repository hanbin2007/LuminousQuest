import { execSync } from 'node:child_process';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

// 构建身份注入:页面可显示自己出自哪个 commit,肉眼即可核对"跑的是不是改过的代码"。
function buildInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return { commit, dirty, builtAt: new Date().toISOString() };
  } catch {
    return { commit: 'unknown', dirty: false, builtAt: new Date().toISOString() };
  }
}

export default defineConfig({
  define: {
    __LQ_BUILD_INFO__: JSON.stringify(buildInfo()),
  },
  plugins: [react(), ...(tailwindcss() as unknown as Plugin[])],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    manifest: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) => {
            request.setHeader('origin', 'http://127.0.0.1:4173');
          });
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: [
        'shared/chemistry/equation.ts',
        'shared/scoring/**/*.ts',
        'shared/workflows/**/*.ts',
      ],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
