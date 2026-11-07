// Case-insensitive header maps (internal). A plain object keeps `x-organization-id` and
// `X-Organization-Id` apart and `fetch` joins them ("a, a"); every transport merge goes through here.

/** The key of `name` in `headers`, matched case-insensitively. */
function keyOf(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) return key;
  return undefined;
}

/** The value of `name` (any casing), or `undefined`. */
export function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = keyOf(headers, name);
  return key === undefined ? undefined : headers[key];
}

/** Set `name`, replacing any entry of the same name in another casing. Mutates `headers`. */
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const key = keyOf(headers, name);
  if (key !== undefined) delete headers[key];
  headers[name] = value;
}

/** Remove `name` in any casing. Mutates `headers`. */
export function deleteHeader(headers: Record<string, string>, name: string): void {
  const key = keyOf(headers, name);
  if (key !== undefined) delete headers[key];
}

/** A new map of the layers in order; a later layer wins over an earlier one, case-insensitively. */
export function mergeHeaders(
  ...layers: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [name, value] of Object.entries(layer)) setHeader(out, name, value);
  }
  return out;
}
