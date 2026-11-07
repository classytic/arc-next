/**
 * Test-signal guard: React "not wrapped in act(...)" warnings FAIL the test
 * that produced them instead of scrolling past in stderr. Unwrapped updates
 * are real lifecycle bugs waiting to happen (assertions racing state) — a
 * green suite with act noise is a weaker guarantee than it looks.
 *
 * Intentional console.error usage in tests (e.g. the async-token dev warn)
 * is unaffected — only the act() warning shape is captured.
 */

import { afterEach, beforeEach } from "vitest";

let actWarnings: string[] = [];
const originalError = console.error.bind(console);

console.error = (...args: unknown[]): void => {
  const first =
    typeof args[0] === "string" ? args[0] : args[0] instanceof Error ? args[0].message : "";
  if (first.includes("not wrapped in act")) {
    actWarnings.push(first.split("\n")[0] ?? first);
  }
  originalError(...args);
};

beforeEach(() => {
  actWarnings = [];
});

afterEach(() => {
  if (actWarnings.length > 0) {
    const summary = actWarnings.slice(0, 3).join("\n  ");
    actWarnings = [];
    throw new Error(
      `React act() warning(s) emitted during this test — wrap the state-updating event in act()/waitFor():\n  ${summary}`,
    );
  }
});
