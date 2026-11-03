#!/usr/bin/env node
/**
 * Peer-floor gate: proves every `peerDependencies` floor (`>=X`) is real.
 *
 * Copies the repo (minus node_modules / dist / .git) into a temp dir, pins
 * each peer's devDependency to the EXACT floor version, installs, and runs
 * `typecheck`, `typecheck:tests`, `test`, `build` and `check:fixtures` there.
 * The working tree is never touched. A floor that is too low fails here.
 * Policy for the other direction: raise a floor only when this script fails
 * at the old floor, and say which API/behavior forced it in the CHANGELOG.
 * Never raise floors to "latest" alongside devDependency bumps.
 *
 * Companions are pinned with their peer: `react-dom` to the react floor,
 * `@types/react` / `@types/react-dom` to the latest patch of the react floor's
 * minor (types have their own patch cadence).
 *
 * Needs the npm registry (or a warm npm cache: installs use --prefer-offline),
 * so it is NOT in `npm test` / `prepublishOnly`. Run it as a release step and
 * in CI (`peer-minimums` job):
 *
 *   npm run check:peer-floors
 *   npm run check:peer-floors -- --set @tanstack/react-query@5.40.0   # bisect one peer
 *   npm run check:peer-floors -- --keep                               # keep the temp dir
 */

import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const overrides = new Map();
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--set") continue;
  const spec = args[++i] ?? "";
  const at = spec.lastIndexOf("@");
  if (at <= 0) throw new Error(`--set expects <name>@<version>, got "${spec}"`);
  overrides.set(spec.slice(0, at), spec.slice(at + 1));
}

/** Floor of a `>=X.Y.Z` range. Anything else is a policy violation. */
function floorOf(name, range) {
  const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!m) throw new Error(`peerDependencies["${name}"] = "${range}": expected ">=X.Y.Z"`);
  return m[1];
}

const pins = {};
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  pins[name] = overrides.get(name) ?? floorOf(name, range);
}
if (pins.react) {
  const [major, minor] = pins.react.split(".");
  pins["react-dom"] = overrides.get("react-dom") ?? pins.react;
  pins["@types/react"] = overrides.get("@types/react") ?? `~${major}.${minor}.0`;
  pins["@types/react-dom"] = overrides.get("@types/react-dom") ?? `~${major}.${minor}.0`;
}
for (const [name, version] of overrides) pins[name] ??= version;

const tmp = mkdtempSync(path.join(os.tmpdir(), "arc-next-peer-floors-"));
// Skip symlinks (local agent-skill links; Windows can't recreate them without
// privileges). Top level: skip install/build output and dot-dirs (.git, agent
// tooling); keep .npmrc (engine-strict). Below top level: copy everything.
const SKIP = new Set(["node_modules", "dist", "coverage"]);
cpSync(ROOT, tmp, {
  recursive: true,
  filter: (src) => {
    if (lstatSync(src).isSymbolicLink()) return false;
    if (path.dirname(src) !== ROOT) return true;
    const base = path.basename(src);
    if (base === ".npmrc") return true;
    return !SKIP.has(base) && !base.startsWith(".") && !base.endsWith(".tgz");
  },
});

const tmpPkg = JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8"));
for (const [name, version] of Object.entries(pins)) tmpPkg.devDependencies[name] = version;
writeFileSync(path.join(tmp, "package.json"), `${JSON.stringify(tmpPkg, null, 2)}\n`);

console.log("[peer-floors] pins:");
for (const [name, version] of Object.entries(pins)) console.log(`  ${name}@${version}`);
console.log(`[peer-floors] workdir: ${tmp}`);

// Under `npm run`, npm exports its resolved config as npm_config_* (including
// local_prefix = THIS repo, and user-level keys a nested install rejects).
// Strip them so the nested npm resolves config afresh for the temp dir.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^npm_(config|package|lifecycle)_/i.test(k)),
);

function run(cmd) {
  console.log(`\n[peer-floors] $ ${cmd}`);
  const r = spawnSync(cmd, { cwd: tmp, stdio: "inherit", shell: true, env: childEnv });
  return r.status === 0;
}

let ok = run("npm install --prefer-offline --no-audit --no-fund --ignore-scripts");

if (ok) {
  // Prove the floors are what actually resolved (no hoisted newer copy).
  console.log("\n[peer-floors] resolved:");
  for (const [name, wanted] of Object.entries(pins)) {
    const got = JSON.parse(
      readFileSync(path.join(tmp, "node_modules", name, "package.json"), "utf8"),
    ).version;
    // `~X.Y.0` accepts any X.Y.* patch; anything else must resolve exactly.
    const tilde = /^~(\d+\.\d+)\.0$/.exec(wanted);
    const match = tilde ? got.startsWith(`${tilde[1]}.`) : got === wanted;
    console.log(`  ${name}@${got}${match ? "" : `  (wanted ${wanted})`}`);
    if (!match) ok = false;
  }
}

const results = [];
if (ok) {
  // build + check:fixtures: consumer fixtures type-check against the dist
  // emitted with the floor versions' types.
  for (const script of ["typecheck", "typecheck:tests", "test", "build", "check:fixtures"]) {
    const passed = run(`npm run ${script}`);
    results.push([script, passed]);
    if (!passed) ok = false;
  }
}

console.log("\n[peer-floors] summary:");
for (const [script, passed] of results) console.log(`  ${passed ? "PASS" : "FAIL"}  ${script}`);
if (!keep) rmSync(tmp, { recursive: true, force: true });
else console.log(`[peer-floors] kept ${tmp}`);

if (!ok) {
  console.error("[peer-floors] FAILED: a declared peer floor does not hold.");
  process.exit(1);
}
console.log("[peer-floors] OK: every declared peer floor typechecks, passes the suite and builds.");
