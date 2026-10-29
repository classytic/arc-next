// @vitest-environment node
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "check-skills.mjs");

function run(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    return { code: 0, out };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { code: failed.status ?? 1, out: String(failed.stderr ?? "") };
  }
}

const copies: string[] = [];
function sandbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "arc-next-skills-"));
  copies.push(dir);
  for (const entry of ["package.json", "api-surface.json", "llms.txt", "skills/arc-next"]) {
    cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  cpSync(path.join(ROOT, "src", "hooks.ts"), path.join(dir, "src", "hooks.ts"));
  return dir;
}

afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

const edit = (dir: string, file: string, change: (text: string) => string) => {
  const full = path.join(dir, file);
  writeFileSync(full, change(readFileSync(full, "utf8")));
};

describe("skills and llms.txt", () => {
  it("match the current package", () => {
    const result = run(ROOT);
    expect(result.out).toContain("OK Skills");
    expect(result.code).toBe(0);
  });

  it("fail on an identifier the package does not export", () => {
    const dir = sandbox();
    edit(
      dir,
      "skills/arc-next/references/core-hooks.md",
      (t) => `${t}\nUse \`useNotARealHook\`.\n`,
    );
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('identifier "useNotARealHook"');
  });

  it("fail on a subpath that is not in package.json exports", () => {
    const dir = sandbox();
    edit(dir, "skills/arc-next/references/sdk-core.md", (t) => `${t}\nSee \`/sdk/missing\`.\n`);
    edit(
      dir,
      "skills/arc-next/references/core-hooks.md",
      (t) => `${t}\nimport "@classytic/arc-next/nope";\n`,
    );
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('subpath "/sdk/missing"');
    expect(result.out).toContain('subpath "/nope"');
  });

  it("fail on a named import the subpath does not export", () => {
    const dir = sandbox();
    edit(
      dir,
      "skills/arc-next/references/core-hooks.md",
      (t) =>
        `${t}\n\`\`\`ts\nimport { createCrudApi, nothingHere } from "@classytic/arc-next/api";\n\`\`\`\n`,
    );
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("import { nothingHere } is not exported by /api");
  });

  it("fail on banned words, em-dashes and emoji", () => {
    const dir = sandbox();
    edit(
      dir,
      "skills/arc-next/references/client-server.md",
      (t) => `${t}\nThis is the legacy way—avoid. \u{1F600}\n`,
    );
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('banned word "legacy"');
    expect(result.out).toContain("em-dash");
    expect(result.out).toContain("emoji");
  });

  it("enforce the size budgets", () => {
    const dir = sandbox();
    edit(
      dir,
      "skills/arc-next/references/realtime-uploads.md",
      (t) => `${t}\n${"x".repeat(9000)}\n`,
    );
    edit(dir, "llms.txt", (t) => `${t}\n${"y".repeat(3200)}\n`);
    edit(dir, "skills/arc-next/SKILL.md", (t) => `${t}\n${"z".repeat(300)}\n`);
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("realtime-uploads.md");
    expect(result.out).toContain("llms.txt");
    expect(result.out).toContain("body is");
  });

  it("fail when llms.txt and the SKILL.md table drift apart", () => {
    const dir = sandbox();
    edit(dir, "llms.txt", (t) => t.replace("definePublicEnv", "createDownloader"));
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("identifiers differ from the SKILL.md table");
  });
});
