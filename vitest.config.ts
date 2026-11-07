import { defineConfig } from "vitest/config";

/**
 * Tests live in `tests/<domain>/` (mirroring `src/<domain>/`), never in `src/`, so nothing test-only
 * can ship. The environment is chosen by the file name, not by a hand list:
 *
 *   *.native.test.ts       native  React Native entry points: Node with NO DOM globals at all
 *   *.ssr.test.ts(x)       ssr     Server Components helpers: Node, server QueryClient, streaming
 *   *.node.test.ts         node    pure core (crypto, edge cache, server helpers, sdk, contracts)
 *   *.test.ts(x)           jsdom   everything that renders React or touches web storage / DOM
 *   *.test-d.ts            types   `expectTypeOf` contracts, checked by `vitest --typecheck`
 *
 * Shared helpers are in `tests/harness/`, per-environment setup in `tests/setup/`.
 */
const NATIVE = "tests/**/*.native.test.ts";
const SSR = "tests/**/*.ssr.test.{ts,tsx}";
const NODE = "tests/**/*.node.test.ts";

export default defineConfig({
  test: {
    globals: true,
    restoreMocks: true,
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["tests/**", "src/**/*.d.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: {
        // Core domains: the transport, the query layer, auth.
        "src/client/**": { lines: 80, functions: 75, branches: 70 },
        "src/query/**": { lines: 85, functions: 80, branches: 75 },
        "src/auth/**": { lines: 80, functions: 80, branches: 70 },
      },
    },
    projects: [
      {
        extends: true,
        test: { name: "jsdom", environment: "jsdom", include: ["tests/**/*.test.{ts,tsx}"], exclude: [NATIVE, SSR, NODE], setupFiles: ["tests/setup/dom.ts"] },
      },
      {
        extends: true,
        test: { name: "node", environment: "node", include: [NODE] },
      },
      {
        extends: true,
        test: { name: "ssr", environment: "node", include: [SSR], setupFiles: ["tests/setup/ssr.ts"] },
      },
      {
        extends: true,
        test: {
          name: "types",
          include: [],
          typecheck: { enabled: true, only: true, include: ["tests/**/*.test-d.ts"], tsconfig: "./tsconfig.test.json" },
        },
      },
      {
        extends: true,
        test: { name: "native", environment: "node", include: [NATIVE], setupFiles: ["tests/setup/native.ts"] },
      },
    ],
  },
});
