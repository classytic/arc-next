#!/usr/bin/env node
/**
 * Skill gate: the agent skill (skills/arc-next/**) and llms.txt must describe the CURRENT package.
 *
 * Checks, all against files in the repo (no build needed; api-surface.json is itself gated
 * against the built package by `check:api-surface`):
 *   1. size budgets: SKILL.md body <= 6 KB, description <= 400 chars, each reference <= 8 KB,
 *      llms.txt <= 3 KB;
 *   2. every `@classytic/arc-next/<subpath>` and every backticked or parenthesised `/<subpath>` is a
 *      real entry of package.json "exports"; every named import from the package exists in
 *      api-surface.json for that subpath;
 *   3. every API-looking identifier (use*, create*, define*, with*, configure*, init*) is an export of
 *      some subpath, a member of the createCrudHooks bundle, or a known third-party name;
 *   4. banned words (deprecated, legacy, formerly, backward compat, old way, migration), em-dashes
 *      and emoji;
 *   5. llms.txt and the SKILL.md "Do not hand-roll" table name the same identifiers and subpaths.
 *
 * Usage: node scripts/check-skills.mjs [--root <dir>]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const BUDGET = { skillBody: 6 * 1024, description: 400, reference: 8 * 1024, llms: 3 * 1024 };
const BANNED = /\b(deprecated|legacy|formerly|backward[- ]compat\w*|old way|migration)\b/i;
const EM_DASH = /—/;
const EMOJI = /\p{Extended_Pictographic}/u;
const API_ID = /\b(?:use|create|define|with|configure|init)[A-Z][A-Za-z0-9]*\b/g;
/** Third-party names the skills legitimately mention. */
const EXTERNAL = new Set([
  "useQuery",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "useMutation",
  "useQueryClient",
  "useRouter",
  "useTransition",
]);

export function checkSkills(root) {
  const errors = [];
  const fail = (file, message) => errors.push(`${file}: ${message}`);
  const read = (file) => readFileSync(path.join(root, file), "utf8");

  const pkg = JSON.parse(read("package.json"));
  const subpaths = new Set(
    Object.keys(pkg.exports)
      .filter((key) => key !== "./package.json")
      .map((key) => (key === "." ? "" : key.slice(1))),
  );
  const surface = JSON.parse(read("api-surface.json"));
  const namesOf = (sub) => new Set([...(surface[sub]?.runtime ?? []), ...(surface[sub]?.types ?? [])]);
  const known = new Set(EXTERNAL);
  for (const key of Object.keys(surface)) for (const name of namesOf(key)) known.add(name);

  // Members of the createCrudHooks bundle: the final `return { ... };` of the factory.
  const hooksSrc = read("src/hooks.ts");
  const bundle = /\n {2}return \{\n {4}KEYS,([\s\S]*?)\n {2}\};/.exec(hooksSrc);
  if (!bundle) fail("src/hooks.ts", "cannot find the createCrudHooks return block");
  for (const match of (bundle?.[1] ?? "").matchAll(/^ {4}(\w+),?$/gm)) known.add(match[1]);

  const skillDir = "skills/arc-next";
  const files = [`${skillDir}/SKILL.md`, "llms.txt"];
  const refDir = path.join(root, skillDir, "references");
  if (existsSync(refDir)) {
    for (const name of readdirSync(refDir).sort()) {
      if (name.endsWith(".md")) files.push(`${skillDir}/references/${name}`);
    }
  }
  for (const file of files) {
    if (!existsSync(path.join(root, file))) fail(file, "missing");
  }

  const texts = new Map();
  for (const file of files) if (existsSync(path.join(root, file))) texts.set(file, read(file));

  // 1. size budgets and frontmatter
  const skill = texts.get(`${skillDir}/SKILL.md`);
  if (skill) {
    const parts = skill.split(/^---\s*$/m);
    const front = parts[1] ?? "";
    const body = parts.slice(2).join("---");
    const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
    if (!/^name:\s*arc-next\s*$/m.test(front)) fail("SKILL.md", "frontmatter name must be arc-next");
    if (!/minVersion:\s*"?\d+\.\d+\.\d+"?/.test(front)) fail("SKILL.md", "metadata.minVersion missing");
    if (description.length === 0) fail("SKILL.md", "description missing");
    if (description.length > BUDGET.description) {
      fail("SKILL.md", `description is ${description.length} chars (max ${BUDGET.description})`);
    }
    const bytes = Buffer.byteLength(body);
    if (bytes > BUDGET.skillBody) fail("SKILL.md", `body is ${bytes} B (max ${BUDGET.skillBody})`);
    for (const heading of ["## Do not hand-roll", "## Golden path", "## Gotchas", "## Never", "## References"]) {
      if (!body.includes(heading)) fail("SKILL.md", `missing section "${heading}"`);
    }
  }
  for (const [file, text] of texts) {
    const bytes = Buffer.byteLength(text);
    if (file === "llms.txt" && bytes > BUDGET.llms) fail(file, `${bytes} B (max ${BUDGET.llms})`);
    if (file.includes("/references/") && bytes > BUDGET.reference) {
      fail(file, `${bytes} B (max ${BUDGET.reference})`);
    }
  }

  // 4. banned words, em-dashes, emoji
  for (const [file, text] of texts) {
    const banned = BANNED.exec(text);
    if (banned) fail(file, `banned word "${banned[0]}"`);
    if (EM_DASH.test(text)) fail(file, "contains an em-dash");
    if (EMOJI.test(text)) fail(file, "contains an emoji");
  }

  // 2 + 3. subpaths, imports, identifiers
  const subpathsIn = (text) => {
    const found = new Set();
    for (const m of text.matchAll(/@classytic\/arc-next(\/[a-z0-9/*-]*[a-z0-9*])?/g)) found.add(m[1] ?? "");
    for (const m of text.matchAll(/`(\/[a-z][a-z0-9-]*(?:\/[a-z0-9*-]+)?)`/g)) found.add(m[1]);
    for (const m of text.matchAll(/\((\/[a-z][a-z0-9-]*(?:\/[a-z0-9*-]+)?)[,)]/g)) found.add(m[1]);
    return found;
  };
  const exists = (sub) => {
    if (subpaths.has(sub)) return true;
    if (sub.endsWith("/*")) return [...subpaths].some((s) => s.startsWith(sub.slice(0, -1)));
    return false;
  };
  const idsIn = (text) => new Set(text.match(API_ID) ?? []);

  for (const [file, text] of texts) {
    for (const sub of subpathsIn(text)) {
      if (!exists(sub)) fail(file, `subpath "${sub || "."}" is not in package.json exports`);
    }
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']@classytic\/arc-next(\/[^"']*)?["']/g)) {
      const sub = m[2] ?? "";
      const exported = namesOf(sub === "" ? "." : `.${sub}`);
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (name && !exported.has(name)) fail(file, `import { ${name} } is not exported by ${sub || "."}`);
      }
    }
    for (const id of idsIn(text)) {
      if (!known.has(id)) fail(file, `identifier "${id}" is not exported by arc-next`);
    }
  }

  // 5. llms.txt and the SKILL.md table agree
  const llms = texts.get("llms.txt");
  if (skill && llms) {
    const start = skill.indexOf("## Do not hand-roll");
    const end = skill.indexOf("## Golden path");
    const table = start >= 0 && end > start ? skill.slice(start, end) : "";
    const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
    const skillIds = idsIn(table);
    const llmsIds = idsIn(llms);
    if (!same(skillIds, llmsIds)) {
      const diff = [...skillIds, ...llmsIds].filter((id) => skillIds.has(id) !== llmsIds.has(id));
      fail("llms.txt", `identifiers differ from the SKILL.md table: ${[...new Set(diff)].join(", ")}`);
    }
    const skillSubs = new Set([...subpathsIn(table)].filter(Boolean));
    const llmsSubs = new Set([...subpathsIn(llms)].filter(Boolean));
    if (!same(skillSubs, llmsSubs)) {
      const diff = [...skillSubs, ...llmsSubs].filter((s) => skillSubs.has(s) !== llmsSubs.has(s));
      fail("llms.txt", `subpaths differ from the SKILL.md table: ${[...new Set(diff)].join(", ")}`);
    }
  }
  return errors;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const flag = process.argv.indexOf("--root");
  const root = flag >= 0 ? path.resolve(process.argv[flag + 1]) : process.cwd();
  const errors = checkSkills(root);
  if (errors.length > 0) {
    console.error(`X Skill check failed (${errors.length}):\n`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("OK Skills and llms.txt match the package (budgets, subpaths, identifiers, wording).");
}
