/**
 * `@classytic/arc-next/field-encryption` — client decrypt for arc's
 * FIELD-mode ALE (`@classytic/arc/encryption` with `mode: 'fields'`).
 *
 * Field-mode responses stay `application/json`; only the configured field
 * VALUES arrive as authenticated `arc.v1` envelopes
 * (`arc.v1.<b64url(kid)>.<b64url(iv)>.<b64url(ct)>.<b64url(tag)>`,
 * AES-256-GCM). This helper parses and decrypts those envelopes with the
 * shared symmetric key, via Web Crypto — zero dependencies, works in Node
 * 22+, Bun, Deno, and React Native (with a Web Crypto polyfill).
 *
 * ── SECURITY: trusted runtimes ONLY ─────────────────────────────────────
 * Field mode is SYMMETRIC — whoever holds the key can decrypt every
 * envelope ever produced under it. That key belongs in a Node BFF, a
 * server component, or a native app's secure storage. It must NEVER ship
 * in a browser bundle: anything readable by browser JavaScript is readable
 * by every visitor. For payloads a browser must decrypt, use the
 * asymmetric JWE path (`@classytic/arc-next/encryption`) instead — that is
 * exactly why this lives in its own subpath the web bundle never imports.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Fail-closed: unknown `kid`, tampered ciphertext, or a malformed
 * `arc.v1.*` token throws — an encrypted field is never silently passed
 * through as ciphertext or dropped.
 *
 * @example Node BFF / server component
 * ```ts
 * import { createFieldDecryption } from '@classytic/arc-next/field-encryption';
 *
 * const ale = createFieldDecryption({
 *   // 32-byte AES-256 keys by kid — keep the previous kid during rotation.
 *   keys: { 'k-2026-07': keyBytes },
 * });
 *
 * configureClient({
 *   baseUrl: env.ARC_URL,
 *   afterResponse: async (ctx) => {
 *     // arc stamps `x-encrypted: true` on field-mode responses — only
 *     // those are scanned; every other response passes through untouched.
 *     if (ctx.response.headers.get('x-encrypted') === 'true') {
 *       ctx.body = await ale.decryptFieldsDeep(ctx.body);
 *     }
 *     return ctx;
 *   },
 * });
 * ```
 */

/** Version prefix shared with `@classytic/arc/encryption`'s field cipher. */
export const FIELD_ENVELOPE_PREFIX = 'arc.v1';

const ENVELOPE_PARTS = 6; // arc . v1 . kid . iv . ct . tag
const KEY_BYTES = 32; // AES-256
const decoder = new TextDecoder();

/** Parsed `arc.v1` envelope — `kid` exposed for key resolution. */
export interface ParsedFieldEnvelope {
  readonly kid: string;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

export interface FieldDecryptionOptions {
  /**
   * 32-byte AES-256 keys indexed by `kid`. Keep 2–3 entries across a key
   * rotation so envelopes minted under the previous `kid` still decrypt.
   */
  keys: Record<string, Uint8Array>;
}

export interface FieldDecryption {
  /** Decrypt one `arc.v1` envelope → plaintext string. Throws on tamper/unknown kid. */
  decryptField(token: string): Promise<string>;
  /**
   * Walk a parsed JSON value and decrypt every `arc.v1.*` string in place
   * (arrays and plain objects recursed; other types untouched). Returns the
   * same reference for pipeline ergonomics.
   */
  decryptFieldsDeep<T>(data: T): Promise<T>;
}

function b64urlToBytes(part: string): Uint8Array {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const bin = atob(padded); // throws on non-base64 input — caller maps to null
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Parse an `arc.v1` envelope, or `null` when the token isn't one. */
export function parseFieldEnvelope(token: string): ParsedFieldEnvelope | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== ENVELOPE_PARTS) return null;
  const [v0, v1, kidPart, ivPart, ctPart, tagPart] = parts;
  if (`${v0}.${v1}` !== FIELD_ENVELOPE_PREFIX) return null;
  if (!kidPart || !ivPart || !ctPart || !tagPart) return null;
  try {
    return {
      kid: decoder.decode(b64urlToBytes(kidPart)),
      iv: b64urlToBytes(ivPart),
      ciphertext: b64urlToBytes(ctPart),
      tag: b64urlToBytes(tagPart),
    };
  } catch {
    return null;
  }
}

/** True when a value LOOKS like an envelope (prefix match — cheap scan gate). */
function hasEnvelopePrefix(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${FIELD_ENVELOPE_PREFIX}.`);
}

/** True when a value is a well-formed `arc.v1` envelope. */
export function isFieldEnvelope(value: unknown): value is string {
  return hasEnvelopePrefix(value) && parseFieldEnvelope(value) !== null;
}

/**
 * Build the field-mode decryptor. Keys are validated eagerly (fail-fast at
 * boot, not on the first sensitive response) and imported into Web Crypto
 * once per `kid`, then cached.
 */
export function createFieldDecryption(options: FieldDecryptionOptions): FieldDecryption {
  const kids = Object.keys(options.keys);
  if (kids.length === 0) {
    throw new Error('[arc-next/field-encryption] at least one key is required.');
  }
  for (const kid of kids) {
    const key = options.keys[kid];
    if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
      throw new Error(
        `[arc-next/field-encryption] key '${kid}' must be a ${KEY_BYTES}-byte Uint8Array (AES-256).`,
      );
    }
  }

  const imported = new Map<string, Promise<CryptoKey>>();
  function keyFor(kid: string): Promise<CryptoKey> {
    let p = imported.get(kid);
    if (!p) {
      const raw = options.keys[kid];
      if (!raw) {
        throw new Error(
          `[arc-next/field-encryption] no key for kid '${kid}' — keep the previous ` +
            'kid configured during rotation so in-flight envelopes still decrypt.',
        );
      }
      p = crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
        'decrypt',
      ]);
      imported.set(kid, p);
    }
    return p;
  }

  async function decryptField(token: string): Promise<string> {
    const envelope = parseFieldEnvelope(token);
    if (!envelope) {
      throw new Error('[arc-next/field-encryption] malformed arc.v1 envelope.');
    }
    const key = await keyFor(envelope.kid);
    // Web Crypto expects ciphertext||tag; arc's envelope carries them split.
    const combined = new Uint8Array(envelope.ciphertext.length + envelope.tag.length);
    combined.set(envelope.ciphertext);
    combined.set(envelope.tag, envelope.ciphertext.length);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: envelope.iv as BufferSource },
        key,
        combined,
      );
      return decoder.decode(plaintext);
    } catch {
      // Web Crypto reports every failure as an opaque OperationError — surface
      // the two real causes without leaking crypto internals.
      throw new Error(
        `[arc-next/field-encryption] decryption failed for kid '${envelope.kid}' — ` +
          'tampered ciphertext or wrong key.',
      );
    }
  }

  async function walk(node: unknown): Promise<void> {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const value = node[i];
        if (hasEnvelopePrefix(value)) node[i] = await decryptField(value);
        else await walk(value);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      for (const prop of Object.keys(record)) {
        const value = record[prop];
        if (hasEnvelopePrefix(value)) record[prop] = await decryptField(value);
        else await walk(value);
      }
    }
  }

  async function decryptFieldsDeep<T>(data: T): Promise<T> {
    if (hasEnvelopePrefix(data)) return (await decryptField(data)) as unknown as T;
    await walk(data);
    return data;
  }

  return { decryptField, decryptFieldsDeep };
}
