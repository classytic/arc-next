/**
 * Next `source` patterns (`headers()`, `redirects()`, `rewrites()`), parsed and compiled the way
 * Next does it: path-to-regexp 6.3 with `delimiter: "/"`, case-insensitive, strict, plus the
 * optional trailing slash Next appends. Internal to `./edge-cache`: the route guard and
 * `edgeRouteMatcher` share it, so what the guard proves is what the matcher (and Next) matches.
 *
 * Grammar: literals (`\` escapes one char), `:name`, `:name(regex)`, unnamed `(regex)`, groups
 * `{prefix:name(regex)suffix}`, each optionally followed by `?`, `*` or `+`. A `/` or `.` right
 * before a parameter is its prefix.
 */

/** A parameter or `{}` group. `pattern` is empty for a plain `{text}` group. */
interface SourceKey {
  prefix: string;
  suffix: string;
  pattern: string;
  modifier: "" | "?" | "*" | "+";
}

export type SourceToken = string | SourceKey;

type LexType = "MODIFIER" | "ESCAPED_CHAR" | "OPEN" | "CLOSE" | "NAME" | "PATTERN" | "CHAR" | "END";

interface LexToken {
  type: LexType;
  index: number;
  value: string;
}

const PREFIXES = "./";
const DEFAULT_PATTERN = "[^\\/]+?";

/** A regex that never matches. */
const NEVER = "(?!)";

/** path-to-regexp's escape: every char that is special in a regex or in a `source`. */
export function escapeString(text: string): string {
  return text.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}

function lex(source: string): LexToken[] {
  const tokens: LexToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "*" || ch === "+" || ch === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: ch });
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= source.length) throw new TypeError(`Trailing escape at ${i}`);
      tokens.push({ type: "ESCAPED_CHAR", index: i, value: source[i + 1] as string });
      i += 2;
      continue;
    }
    if (ch === "{" || ch === "}") {
      tokens.push({ type: ch === "{" ? "OPEN" : "CLOSE", index: i, value: ch });
      i++;
      continue;
    }
    if (ch === ":") {
      let j = i + 1;
      let name = "";
      while (j < source.length && /[0-9A-Za-z_]/.test(source[j] as string)) name += source[j++];
      if (!name) throw new TypeError(`Missing parameter name at ${i}`);
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      let pattern = "";
      let j = i + 1;
      if (source[j] === "?") throw new TypeError(`Pattern cannot start with "?" at ${j}`);
      while (j < source.length) {
        const c = source[j] as string;
        if (c === "\\") {
          pattern += c + (source[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (c === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        } else if (c === "(") {
          depth++;
          if (source[j + 1] !== "?")
            throw new TypeError(`Capturing groups are not allowed at ${j}`);
        }
        pattern += c;
        j++;
      }
      if (depth) throw new TypeError(`Unbalanced pattern at ${i}`);
      if (!pattern) throw new TypeError(`Missing pattern at ${i}`);
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: ch });
    i++;
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}

/** Tokens of a `source`; throws (TypeError) wherever Next's parser throws. */
export function parseSource(source: string): SourceToken[] {
  const tokens = lex(source);
  const result: SourceToken[] = [];
  let i = 0;
  let path = "";
  const tryConsume = (type: LexType): string | undefined => {
    const token = tokens[i];
    if (token && token.type === type) {
      i++;
      return token.value;
    }
    return undefined;
  };
  const mustConsume = (type: LexType): string => {
    const value = tryConsume(type);
    if (value !== undefined) return value;
    const token = tokens[i] as LexToken;
    throw new TypeError(`Unexpected ${token.type} at ${token.index}, expected ${type}`);
  };
  const consumeText = (): string => {
    let text = "";
    let value = tryConsume("CHAR") ?? tryConsume("ESCAPED_CHAR");
    while (value !== undefined) {
      text += value;
      value = tryConsume("CHAR") ?? tryConsume("ESCAPED_CHAR");
    }
    return text;
  };
  const modifier = (): SourceKey["modifier"] =>
    (tryConsume("MODIFIER") ?? "") as SourceKey["modifier"];
  // The default pattern of a parameter: one segment, never running into the text before it.
  const safePattern = (prefix: string): string => {
    const previous = result[result.length - 1];
    const text = prefix || (typeof previous === "string" ? previous : "");
    if (previous && !text) throw new TypeError("Must have text between two parameters");
    if (!text || text.includes("/")) return DEFAULT_PATTERN;
    return `(?:(?!${escapeString(text)})[^\\/])+?`;
  };

  while (i < tokens.length) {
    const char = tryConsume("CHAR");
    const name = tryConsume("NAME");
    const pattern = tryConsume("PATTERN");
    if (name || pattern) {
      let prefix = char ?? "";
      if (!PREFIXES.includes(prefix)) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      const keyPattern = pattern || safePattern(prefix);
      result.push({ prefix, suffix: "", pattern: keyPattern, modifier: modifier() });
      continue;
    }
    const value = char ?? tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    if (tryConsume("OPEN")) {
      const prefix = consumeText();
      const groupName = tryConsume("NAME") ?? "";
      const groupPattern = tryConsume("PATTERN") ?? "";
      const suffix = consumeText();
      mustConsume("CLOSE");
      const pattern = groupName && !groupPattern ? safePattern(prefix) : groupPattern;
      result.push({ prefix, suffix, pattern, modifier: modifier() });
      continue;
    }
    mustConsume("END");
  }
  for (const token of result) keyRegex(token); // Next also rejects what cannot compile.
  return result;
}

/**
 * One occurrence of `key` (one or more when `repeat`), with `first` (escaped) in place of the
 * prefix on the first occurrence. Non-capturing, so it can sit inside a `source` pattern.
 */
function keyBody(key: SourceKey, first: string, repeat: boolean): string {
  const prefix = escapeString(key.prefix);
  const suffix = escapeString(key.suffix);
  if (!key.pattern) {
    return repeat ? `(?:${first}${suffix}(?:${prefix}${suffix})*)` : `(?:${first}${suffix})`;
  }
  const pattern = `(?:${key.pattern})`;
  if (!prefix && !suffix) {
    if (repeat) throw new TypeError("Can not repeat a parameter without a prefix and suffix");
    return pattern;
  }
  return repeat
    ? `(?:${first}(?:${pattern}(?:${suffix}${prefix}${pattern})*)${suffix})`
    : `(?:${first}${pattern}${suffix})`;
}

function keyRegex(token: SourceToken): string {
  if (typeof token === "string") return escapeString(token);
  const repeat = token.modifier === "*" || token.modifier === "+";
  const body = keyBody(token, escapeString(token.prefix), repeat);
  return token.modifier === "?" || token.modifier === "*" ? `${body}?` : body;
}

/** The regex body of `tokens` (no anchors), non-capturing. */
function tokensRegex(tokens: readonly SourceToken[]): string {
  return tokens.map(keyRegex).join("");
}

/** What Next matches for a `source`: anchored, case-insensitive, optional trailing slash. */
export function sourceRegExp(source: string): RegExp {
  return new RegExp(`^${tokensRegex(parseSource(source))}(?:\\/)?$`, "i");
}

/** One literal URL segment: no regex meaning, no `/`, no `.`. */
const LITERAL_SEGMENT = /^[A-Za-z0-9_~-]+$/;

/** True when the part after a first segment starts a new segment (or nothing follows). */
function startsSegment(next: SourceToken | undefined): boolean {
  if (next === undefined) return true;
  return typeof next === "string" ? next.startsWith("/") : next.prefix.startsWith("/");
}

/**
 * True when the first URL segment is plain text (`/`, `/about`, `/courses/:path*`) or a required
 * parameter naming literal segments only (`/:section(courses|practice)`, `/(a|b)+`). Anything
 * else (`/:slug`, `/(.*)`, `/{:slug}`, `/u-:id`, `/:s(a|[0-9]+)`, `/:s(a|b)?`) is dynamic.
 */
export function hasStaticFirstSegment(tokens: readonly SourceToken[]): boolean {
  const [head, next] = tokens;
  if (typeof head === "object") {
    if (head.prefix !== "/" || head.suffix !== "" || !startsSegment(next)) return false;
    if (head.modifier !== "" && head.modifier !== "+") return false;
    return head.pattern.split("|").every((name) => LITERAL_SEGMENT.test(name));
  }
  if (head === undefined || !head.startsWith("/")) return false;
  if (head.indexOf("/", 1) > 0 || next === undefined) return true;
  return head.length > 1 && typeof next !== "string" && next.prefix.startsWith("/");
}

/** The top-level `|` alternatives of a regex body (outside groups and classes). */
function splitAlternatives(pattern: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(pattern.slice(start));
  return parts;
}

/**
 * Every string a regex matches when it is an alternation of literals, possibly in `(?:...)`
 * groups (`a|(?:b|c\.d)`), else undefined. A wrong unwrap of `(?:a)(?:b)` leaves a bare paren,
 * which is never literal, so the answer stays sound.
 */
function literalChoices(pattern: string): string[] | undefined {
  const out: string[] = [];
  for (const part of splitAlternatives(pattern)) {
    if (part.startsWith("(?:") && part.endsWith(")")) {
      const nested = literalChoices(part.slice(3, -1));
      if (!nested) return undefined;
      out.push(...nested);
    } else if (/^(?:[^\\.^$*+?()[\]{}|]|\\[^0-9A-Za-z])*$/.test(part)) {
      out.push(part.replace(/\\(.)/g, "$1"));
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * True when every first segment `tokens` can start with is provably `refused`: the first part is
 * a required parameter whose regex is an alternation of literals, each refused. Shapes it cannot
 * prove return false (the route may still match something).
 */
export function firstSegmentAlwaysRefused(
  tokens: readonly SourceToken[],
  refused: (segment: string) => boolean,
): boolean {
  const [head, next] = tokens;
  if (typeof head !== "object" || head.prefix !== "/" || !head.pattern) return false;
  if (head.modifier === "?" || head.modifier === "*") return false;
  const choices = literalChoices(head.pattern);
  if (!choices) return false;
  return choices.every((choice) => {
    const slash = choice.indexOf("/");
    if (slash >= 0) return refused(choice.slice(0, slash));
    return head.suffix === "" && startsSegment(next) && refused(choice);
  });
}

/**
 * A regex for what follows the leading `/` of every path `tokens` match, so a check can sit at
 * the start of the first segment. A first part that is skipped (`?`, `*`) hands the leading `/`
 * to the next part. Throws when the leading `/` cannot be located (the part could match a `/`).
 */
export function afterLeadingSlash(tokens: readonly SourceToken[]): string {
  const [head, ...rest] = tokens;
  if (head === undefined) return "";
  if (typeof head === "string") {
    return head.startsWith("/") ? escapeString(head.slice(1)) + tokensRegex(rest) : NEVER;
  }
  if (!head.prefix.startsWith("/")) {
    throw new TypeError("cannot locate the first segment (a parameter without a / prefix)");
  }
  const repeat = head.modifier === "*" || head.modifier === "+";
  const present = keyBody(head, escapeString(head.prefix.slice(1)), repeat) + tokensRegex(rest);
  if (head.modifier === "" || head.modifier === "+") return present;
  return `(?:${present}|${afterLeadingSlash(rest)})`;
}
