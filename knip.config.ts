import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // The query lint lane has its own install (TypeScript 5 for typescript-eslint).
  ignore: ["tools/**"],
  project: ["src/**/*.ts"],

  tsdown: {
    config: ["tsdown.config.ts"],
  },

  vitest: {
    config: ["vitest.config.ts"],
    entry: ["tests/**/*.test.{ts,tsx}", "tests/**/*.test-d.ts", "tests/setup/*.ts", "tests/harness/*.ts"],
  },
};

export default config;
