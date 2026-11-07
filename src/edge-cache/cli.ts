#!/usr/bin/env node
/**
 * `arc-next-edge`: the deploy purge as a command. Not a public subpath: it ships only as the
 * package `bin`. Run it once the NEW build is live:
 *
 *   arc-next-edge purge --host example.com --env-file .env.production
 *
 * Credentials come from the environment only (never argv, which other processes can read).
 * Precedence: the process environment wins; each `--env-file` only fills keys that are still
 * unset or empty, and an earlier file wins over a later one. So a CI secret is never overridden
 * by a stale file. Secret values are redacted from every line this command prints.
 *
 * {@link runEdgeCli} is the whole command with its inputs injected; the module runs it only when
 * it is the process entry, so importing it does nothing. Node globals and builtins are reached
 * through local types and on-call imports, keeping Node types out of the browser-typed `src/`.
 */

import { CLOUDFLARE_ENV, purgeEdgeHost } from "./cloudflare.js";

type Env = Record<string, string | undefined>;

export interface EdgeCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface EdgeCliDeps {
  /** Arguments after the executable and script, e.g. `["purge", "--host", "example.com"]`. */
  argv: readonly string[];
  /** The process environment. Default `process.env`. */
  env?: Env;
  /** Where lines go. Default the process streams. */
  io?: EdgeCliIo;
  /** The purge. Default {@link purgeEdgeHost}. */
  purge?: typeof purgeEdgeHost;
  /** Reads and parses one env file. Default `fs.readFileSync` + `util.parseEnv`. */
  readEnvFile?: (path: string) => Promise<Record<string, string>>;
}

export const EDGE_CLI_USAGE = `Usage: arc-next-edge purge --host <host> [--host <host>]... [--env-file <path>]...

Empty the CDN edge cache for a host after a deploy. Run it once the NEW build is live:
pages cached before that point at the old build's assets.

Options:
  --host <host>       Host name to purge, e.g. example.com (no scheme or path). Repeatable.
  --env-file <path>   Dotenv file to read credentials from. Repeatable. The process
                      environment wins: a file only fills keys that are unset or empty,
                      and an earlier file wins over a later one.
  -h, --help          Show this help.

Environment:
  ${CLOUDFLARE_ENV.zoneId}       Cloudflare zone id.
  ${CLOUDFLARE_ENV.apiToken}   API token with only Zone > Cache Purge. Never printed.

Exit status: 0 when every host was purged, 1 on a failure or a usage error.`;

/** Env keys whose values are never printed. */
const SECRET_KEY = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;
const REDACTED = "[redacted]";

const redactor = (env: Env) => {
  const secrets = Object.entries(env)
    .filter(([key, value]) => (key === CLOUDFLARE_ENV.apiToken || SECRET_KEY.test(key)) && value)
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4)
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b.length - a.length);
  return (text: string) => secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text);
};

interface ParsedArgs {
  help: boolean;
  command?: string;
  hosts: string[];
  envFiles: string[];
  error?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, hosts: [], envFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === "--host" || flag === "--env-file") {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (!value || (eq < 0 && value.startsWith("-"))) {
        out.error ??= `${flag} needs a value.`;
        continue;
      }
      (flag === "--host" ? out.hosts : out.envFiles).push(value);
      continue;
    }
    if (arg.startsWith("-")) out.error ??= `Unknown option ${flag}.`;
    else if (out.command === undefined) out.command = arg;
    else out.error ??= `Unexpected argument ${arg}.`;
  }
  return out;
}

const isBlank = (value: string | undefined) => value === undefined || value === "";

// ── Node wiring (reached only when the defaults are used) ───────────────────────────────────

interface NodeProcess {
  argv: string[];
  env: Env;
  exitCode?: number;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const nodeProcess = (): NodeProcess | undefined =>
  (globalThis as { process?: NodeProcess }).process;

// Specifiers in variables: `src/` is typed for the browser, and bundlers leave these alone.
const FS: string = "node:fs";
const UTIL: string = "node:util";
const URL_MODULE: string = "node:url";

async function readEnvFileWithNode(path: string): Promise<Record<string, string>> {
  const fs = (await import(FS)) as { readFileSync(path: string, encoding: "utf8"): string };
  const util = (await import(UTIL)) as { parseEnv(content: string): Record<string, string> };
  return util.parseEnv(fs.readFileSync(path, "utf8"));
}

/**
 * The `arc-next-edge` command. Resolves the exit status (0 purged, 1 failure or usage error);
 * never throws and never prints a secret value.
 */
export async function runEdgeCli(deps: EdgeCliDeps): Promise<number> {
  const proc = nodeProcess();
  const io: EdgeCliIo = deps.io ?? {
    stdout: (line) => proc?.stdout.write(`${line}\n`),
    stderr: (line) => proc?.stderr.write(`${line}\n`),
  };
  const purge = deps.purge ?? purgeEdgeHost;
  const readEnvFile = deps.readEnvFile ?? readEnvFileWithNode;
  const env: Env = { ...(deps.env ?? proc?.env ?? {}) };
  let redact = redactor(env);

  const args = parseArgs(deps.argv);
  if (args.help) {
    io.stdout(EDGE_CLI_USAGE);
    return 0;
  }
  const usageError = (message: string) => {
    io.stderr(redact(`arc-next-edge: ${message}`));
    io.stderr("Run arc-next-edge --help for usage.");
    return 1;
  };
  if (args.error) return usageError(args.error);
  if (args.command !== "purge") {
    return usageError(
      args.command === undefined ? "Missing command." : `Unknown command ${args.command}.`,
    );
  }
  if (args.hosts.length === 0) return usageError("purge needs --host <host>.");
  const badHost = args.hosts.find((host) => /[/\s:]/.test(host));
  if (badHost !== undefined) {
    return usageError(`--host takes a host name such as example.com, got ${badHost}.`);
  }

  for (const file of args.envFiles) {
    let values: Record<string, string>;
    try {
      values = await readEnvFile(file);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      io.stderr(
        redact(
          `arc-next-edge: cannot read --env-file ${file}${typeof code === "string" ? ` (${code})` : ""}.`,
        ),
      );
      return 1;
    }
    for (const [key, value] of Object.entries(values)) {
      if (isBlank(env[key])) env[key] = value;
    }
    // Every value a file brought in is now a secret to hide too.
    redact = redactor(env);
  }

  let failed = false;
  for (const host of args.hosts) {
    let result: { ok: boolean; message: string };
    try {
      result = await purge({ host, env });
    } catch (error) {
      result = { ok: false, message: `${host}: ${(error as Error)?.message ?? String(error)}` };
    }
    if (result.ok) io.stdout(redact(result.message));
    else {
      failed = true;
      io.stderr(redact(`arc-next-edge: ${result.message}`));
    }
  }
  return failed ? 1 : 0;
}

/** True when this module is the process entry (`node cli.js`, or the npm `bin` link to it). */
async function isProcessEntry(): Promise<boolean> {
  const entry = nodeProcess()?.argv[1];
  if (!entry) return false;
  const fs = (await import(FS)) as { realpathSync(path: string): string };
  const url = (await import(URL_MODULE)) as { fileURLToPath(url: string): string };
  try {
    return fs.realpathSync(entry) === fs.realpathSync(url.fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

void isProcessEntry().then(async (isEntry) => {
  const proc = nodeProcess();
  if (!isEntry || !proc) return;
  proc.exitCode = await runEdgeCli({ argv: proc.argv.slice(2) });
});
