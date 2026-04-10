import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: ["src/**/*.ts"],

  tsdown: {
    config: ["tsdown.config.ts"],
  },

  vitest: {
    config: ["vitest.config.ts"],
    entry: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
  },

  ignoreDependencies: [
    "react",
    "react-dom",
    "@tanstack/react-query",
  ],
};

export default config;
