import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // React act() warnings fail the offending test — see the setup file.
    setupFiles: ['tests/_setup/fail-on-act-warning.ts'],
  },
});
