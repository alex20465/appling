import { defineConfig } from 'vitest/config';

// Only the packages' own tests: a local Desktop build (packages/desktop/app, release) holds copies of dependencies with theirs.
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.{ts,tsx}'] } });
