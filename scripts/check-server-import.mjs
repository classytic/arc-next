#!/usr/bin/env node
/**
 * Server-safety gate for the RSC boundary.
 *
 * Proves two properties of the built dist, per published subpath:
 *
 *   1. **Static graph purity** — no server-safe entry (one WITHOUT a
 *      `"use client"` banner) reaches a client-marked module through its
 *      relative-import closure. A Server Component importing such an entry
 *      would otherwise receive client references it cannot call.
 *   2. **Runtime importability** — every server-safe entry actually imports
 *      in plain Node (no window/document access at module scope).
 *
 * The client-marked set is DERIVED from the dist banners, not hardcoded —
 * adding `"use client"` to a new file automatically extends the boundary,
 * and accidentally dropping a banner from a hook file fails the graph check
 * of anything importing it... by design there is nothing to fail, so the
 * banner set is also printed for review in CI logs.
 *
 * Run after `npm run build`: node scripts/check-server-import.mjs
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** dist-relative module path → has "use client" banner */
const bannerCache = new Map();
function hasClientBanner(distFile) {
  if (!bannerCache.has(distFile)) {
    let banner = false;
    try {
      const head = readFileSync(path.join(ROOT, distFile), "utf8").slice(0, 200);
      banner = /^\s*["']use client["'];?/.test(head);
    } catch {
      // unreadable = not a client module
    }
    bannerCache.set(distFile, banner);
  }
  return bannerCache.get(distFile);
}

/** Relative-import closure of a dist file (package imports are externals). */
function localClosure(distFile, seen = new Set()) {
  if (seen.has(distFile)) return seen;
  seen.add(distFile);
  let text;
  try {
    text = readFileSync(path.join(ROOT, distFile), "utf8");
  } catch {
    return seen;
  }
  for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s*["'](\.[^"']+)["']/g)) {
    const resolved = path
      .join(path.dirname(distFile), m[1])
      .replaceAll("\\", "/");
    localClosure(resolved, seen);
  }
  return seen;
}

const entries = [];
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (subpath === "./package.json") continue;
  const entry = typeof target === "object" ? (target.default ?? target.import) : target;
  if (entry) entries.push({ subpath, entry: entry.replace(/^\.\//, "") });
}

const clientEntries = entries.filter((e) => hasClientBanner(e.entry));
const serverEntries = entries.filter((e) => !hasClientBanner(e.entry));

console.log(
  `client-marked entries (${clientEntries.length}): ${clientEntries.map((e) => e.subpath).join(", ")}`,
);

const failures = [];

for (const { subpath, entry } of serverEntries) {
  const closure = localClosure(entry);
  for (const mod of closure) {
    if (mod !== entry && hasClientBanner(mod)) {
      failures.push(
        `${subpath} (server-safe) reaches client-marked module ${mod} - Server Components importing it will break`,
      );
    }
  }
}

for (const { subpath, entry } of serverEntries) {
  try {
    await import(pathToFileURL(path.join(ROOT, entry)).href);
  } catch (err) {
    failures.push(
      `${subpath} failed to import in plain Node: ${String(err?.message ?? err).split("\n")[0]}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\nX Server-import check failed (${failures.length}):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `OK Server-import check - ${serverEntries.length} server-safe subpaths import cleanly in Node and reach no client-marked modules.`,
);
