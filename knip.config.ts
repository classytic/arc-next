import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: ["src/**/*.ts"],

  tsdown: {
    config: ["tsdown.config.ts"],
  },

  vitest: {
    config: ["vitest.config.ts"],
    entry: ["tests/**/*.test.ts", "tests/**/*.spec.ts", "tests/_setup/*.ts"],
  },
};

export default config;
