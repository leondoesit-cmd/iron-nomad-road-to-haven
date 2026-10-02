import { defineConfig } from 'vitest/config';

export default defineConfig({
  // PORT is assigned by the preview tooling; fall back to Vite's default otherwise.
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5174 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // The whole-leg generation tests take a few seconds each; a loaded machine pushes them past the 5 s default.
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 20000 },
});
