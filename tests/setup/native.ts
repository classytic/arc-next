/**
 * React Native project setup: Node with no DOM at all, identified the way RN identifies itself.
 * Anything an RN entry point touches at module load that only a browser has fails here.
 */

const g = globalThis as Record<string, unknown>;
for (const name of ["window", "document", "localStorage", "sessionStorage", "EventSource"]) {
  if (name in g) delete g[name];
}
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "product", { configurable: true, value: "ReactNative" });
}
