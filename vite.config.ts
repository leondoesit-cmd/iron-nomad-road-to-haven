import { defineConfig } from 'vitest/config';

export default defineConfig({
  // PORT is assigned by the preview tooling; fall back to Vite's default otherwise.
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5174 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
