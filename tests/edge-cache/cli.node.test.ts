/**
 * `arc-next-edge` (the package bin): the deploy purge as a command. Process env wins over
 * `--env-file` values, exit status is 0 or 1, and no secret value is ever printed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EDGE_CLI_USAGE, runEdgeCli } from "../../src/edge-cache/cli.js";
import type { purgeEdgeHost } from "../../src/edge-cache/cloudflare.js";

const TOKEN = "cf-token-9f8e7d6c5b4a";
const FILE_TOKEN = "stale-file-token-1a2b3c";
const OTHER_SECRET = "file-only-secret-xyz123";

const dir = mkdtempSync(path.join(tmpdir(), "arc-next-edge-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const envFile = (name: string, content: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
};

type Purge = typeof purgeEdgeHost;

function run(argv: string[], env: Record<string, string | undefined> = {}, purge?: Purge) {
  const out: string[] = [];
  const err: string[] = [];
  const purgeFn = vi.fn<Purge>(
    purge ?? (async ({ host }) => ({ ok: true, message: `Cloudflare cache purged for ${host}.` })),
  );
  const done = runEdgeCli({
    argv,
    env,
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    purge: purgeFn,
  });
  return done.then((code) => ({ code, out: out.join("\n"), err: err.join("\n"), purge: purgeFn }));
}

const expectNoSecrets = (text: string) => {
  for (const secret of [TOKEN, FILE_TOKEN, OTHER_SECRET]) expect(text).not.toContain(secret);
};

describe("arc-next-edge", () => {
  it("--help prints the usage to stdout and exits 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(EDGE_CLI_USAGE);
    expect(r.out).toContain("arc-next-edge purge --host <host>");
    expect(r.err).toBe("");
    expect((await run(["purge", "-h"])).code).toBe(0);
  });

  it("usage errors exit 1 without purging", async () => {
    for (const argv of [
      [],
      ["purge"],
      ["purge", "--host"],
      ["wipe", "--host", "example.com"],
      ["purge", "--host", "example.com", "--force"],
      ["purge", "--host", "https://example.com"],
    ]) {
      const r = await run(argv, { CLOUDFLARE_PURGE_TOKEN: TOKEN });
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toContain("--help");
      expect(r.purge).not.toHaveBeenCalled();
    }
    expect((await run(["purge"])).err).toContain("purge needs --host <host>.");
  });

  it("purges every --host and exits 0", async () => {
    const env = { CLOUDFLARE_ZONE_ID: "zone", CLOUDFLARE_PURGE_TOKEN: TOKEN };
    const r = await run(["purge", "--host", "example.com", "--host=www.example.com"], env);
    expect(r.code).toBe(0);
    expect(r.purge).toHaveBeenCalledTimes(2);
    expect(r.purge).toHaveBeenNthCalledWith(1, { host: "example.com", env });
    expect(r.purge).toHaveBeenNthCalledWith(2, { host: "www.example.com", env });
    expect(r.out).toContain("Cloudflare cache purged for www.example.com.");
  });

  it("reads --env-file with util.parseEnv; process env wins, earlier files win, blanks are filled", async () => {
    const first = envFile(
      "first.env",
      `# deploy\nCLOUDFLARE_PURGE_TOKEN=${FILE_TOKEN}\nCLOUDFLARE_ZONE_ID="file-zone"\n`,
    );
    const second = envFile("second.env", "CLOUDFLARE_ZONE_ID=later-zone\nEXTRA=1\n");
    const r = await run(
      ["purge", "--host", "example.com", "--env-file", first, `--env-file=${second}`],
      {
        CLOUDFLARE_PURGE_TOKEN: TOKEN,
        CLOUDFLARE_ZONE_ID: "",
      },
    );
    expect(r.code).toBe(0);
    expect(r.purge.mock.calls[0]?.[0].env).toMatchObject({
      CLOUDFLARE_PURGE_TOKEN: TOKEN, // the CI secret is never overridden by a file
      CLOUDFLARE_ZONE_ID: "file-zone", // empty in the process: the first file fills it
      EXTRA: "1",
    });
  });

  it("a missing --env-file exits 1 before any purge", async () => {
    const r = await run([
      "purge",
      "--host",
      "example.com",
      "--env-file",
      path.join(dir, "nope.env"),
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read --env-file");
    expect(r.purge).not.toHaveBeenCalled();
  });

  it("a failed purge exits 1 (missing credentials, a refusal, or a throw)", async () => {
    const real = await import("../../src/edge-cache/cloudflare.js");
    const missing = await run(["purge", "--host", "example.com"], {}, real.purgeEdgeHost);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Set CLOUDFLARE_ZONE_ID and CLOUDFLARE_PURGE_TOKEN");

    const refused = await run(
      ["purge", "--host", "a.com", "--host", "b.com"],
      {},
      async ({ host }) =>
        host === "a.com" ? { ok: false, message: `${host}: refused` } : { ok: true, message: "ok" },
    );
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("ok");

    const thrown = await run(["purge", "--host", "a.com"], {}, async () => {
      throw new Error("network down");
    });
    expect(thrown.code).toBe(1);
    expect(thrown.err).toContain("network down");
  });

  it("never prints a secret value, from the process env or an env file", async () => {
    const file = envFile(
      "secrets.env",
      `CLOUDFLARE_PURGE_TOKEN=${FILE_TOKEN}\nOTHER_API_KEY=${OTHER_SECRET}\n`,
    );
    const echo: Purge = async ({ env }) => ({
      ok: false,
      message: `refused ${env?.CLOUDFLARE_PURGE_TOKEN} ${env?.OTHER_API_KEY}`,
    });
    const leaky = [
      await run(
        ["purge", "--host", "example.com", "--env-file", file],
        { CLOUDFLARE_PURGE_TOKEN: TOKEN },
        echo,
      ),
      await run(["purge", "--host", "example.com", "--env-file", file], {}, echo),
      await run(["purge", TOKEN, "--host", "x.com"], { CLOUDFLARE_PURGE_TOKEN: TOKEN }),
      await run(["purge", `--${OTHER_SECRET}`], { OTHER_API_KEY: OTHER_SECRET }),
    ];
    for (const r of leaky) {
      expect(r.code).toBe(1);
      expectNoSecrets(`${r.out}\n${r.err}`);
    }
    expect(leaky[0]?.err).toContain("[redacted]");
  });
});
