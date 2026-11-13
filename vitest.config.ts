import { defineConfig } from 'vitest/config';

// Only the packages' own tests: worktrees, sandboxes and e2e projects in the repo hold copies with theirs.
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.{ts,tsx}'] } });
