// @vitest-environment node
/**
 * Field-mode ALE — client decrypt interop.
 *
 * Envelopes are minted here with `node:crypto` EXACTLY as
 * `@classytic/arc/encryption`'s fieldCipher does on the server
 * (`arc.v1.<b64url(kid)>.<b64url(iv)>.<b64url(ct)>.<b64url(tag)>`,
 * AES-256-GCM) — so a green suite proves the Web Crypto client decrypts the
 * real wire format, not merely its own output.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createFieldDecryption,
  FIELD_ENVELOPE_PREFIX,
  isFieldEnvelope,
  parseFieldEnvelope,
} from '../src/field-encryption.js';

const KEY = new Uint8Array(randomBytes(32));
const KID = 'k-2026-07';

/** Server-side envelope mint — byte-for-byte arc's `encryptField`. */
function serverEncryptField(plaintext: string, kid: string, key: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FIELD_ENVELOPE_PREFIX,
    Buffer.from(kid, 'utf8').toString('base64url'),
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

describe('parseFieldEnvelope / isFieldEnvelope', () => {
  it('parses a server-minted envelope and exposes the kid', () => {
    const token = serverEncryptField('4242424242424242', KID, KEY);
    const parsed = parseFieldEnvelope(token);
    expect(parsed?.kid).toBe(KID);
    expect(parsed?.iv.length).toBe(12);
    expect(parsed?.tag.length).toBe(16);
    expect(isFieldEnvelope(token)).toBe(true);
  });

  it('rejects non-envelopes without throwing', () => {
    expect(parseFieldEnvelope('plain string')).toBeNull();
    expect(parseFieldEnvelope('arc.v1.only.four.parts')).toBeNull();
    expect(parseFieldEnvelope('arc.v2.a.b.c.d')).toBeNull(); // future version ≠ v1
    expect(isFieldEnvelope(42)).toBe(false);
    expect(isFieldEnvelope(null)).toBe(false);
  });
});

describe('createFieldDecryption', () => {
  it('decrypts a server-minted envelope (cross-implementation interop)', async () => {
    const ale = createFieldDecryption({ keys: { [KID]: KEY } });
    const token = serverEncryptField('4242424242424242', KID, KEY);
    await expect(ale.decryptField(token)).resolves.toBe('4242424242424242');
  });

  it('resolves rotated kids from the key map', async () => {
    const oldKey = new Uint8Array(randomBytes(32));
    const ale = createFieldDecryption({ keys: { [KID]: KEY, 'k-2026-06': oldKey } });
    const oldToken = serverEncryptField('legacy', 'k-2026-06', oldKey);
    await expect(ale.decryptField(oldToken)).resolves.toBe('legacy');
  });

  it('fail-closed: unknown kid throws (rotation gap surfaced, not masked)', async () => {
    const ale = createFieldDecryption({ keys: { [KID]: KEY } });
    const token = serverEncryptField('secret', 'k-gone', KEY);
    await expect(ale.decryptField(token)).rejects.toThrow(/no key for kid 'k-gone'/);
  });

  it('fail-closed: tampered ciphertext throws (GCM tag rejects)', async () => {
    const ale = createFieldDecryption({ keys: { [KID]: KEY } });
    const parts = serverEncryptField('secret', KID, KEY).split('.');
    const ct = Buffer.from(parts[4] as string, 'base64url');
    ct[0] = (ct[0] as number) ^ 0xff; // flip one ciphertext bit
    parts[4] = ct.toString('base64url');
    await expect(ale.decryptField(parts.join('.'))).rejects.toThrow(/tampered|wrong key/);
  });

  it('fail-closed: wrong key throws', async () => {
    const ale = createFieldDecryption({ keys: { [KID]: new Uint8Array(randomBytes(32)) } });
    const token = serverEncryptField('secret', KID, KEY);
    await expect(ale.decryptField(token)).rejects.toThrow(/tampered|wrong key/);
  });

  it('rejects non-32-byte keys at construction (fail-fast, not first response)', () => {
    expect(() => createFieldDecryption({ keys: { bad: new Uint8Array(16) } })).toThrow(/32-byte/);
    expect(() => createFieldDecryption({ keys: {} })).toThrow(/at least one key/);
  });
});

describe('decryptFieldsDeep', () => {
  it('walks a realistic arc list payload and decrypts only envelope values', async () => {
    const ale = createFieldDecryption({ keys: { [KID]: KEY } });
    const body = {
      data: [
        {
          _id: 'a1',
          name: 'Alice',
          cardNumber: serverEncryptField('4242424242424242', KID, KEY),
          nested: { cvv: serverEncryptField('123', KID, KEY) },
        },
        { _id: 'a2', name: 'Bob', cardNumber: null },
      ],
      pagination: { total: 2, page: 1 },
    };
    const result = await ale.decryptFieldsDeep(body);
    expect(result).toBe(body); // in-place, same reference
    expect(result.data[0]?.cardNumber).toBe('4242424242424242');
    expect(result.data[0]?.nested.cvv).toBe('123');
    expect(result.data[0]?.name).toBe('Alice'); // non-envelopes untouched
    expect(result.data[1]?.cardNumber).toBeNull();
    expect(result.pagination.total).toBe(2);
  });

  it('decrypts a bare envelope string and envelopes inside arrays', async () => {
    const ale = createFieldDecryption({ keys: { [KID]: KEY } });
    const bare = serverEncryptField('top-level', KID, KEY);
    await expect(ale.decryptFieldsDeep(bare)).resolves.toBe('top-level');
    const arr = ['plain', serverEncryptField('in-array', KID, KEY)];
    await expect(ale.decryptFieldsDeep(arr)).resolves.toEqual(['plain', 'in-array']);
  });

  it('fail-closed: a malformed arc.v1.* token throws instead of leaking through', async () => {
    const ale = createFieldDecryption({ keys: { [KID]: KEY } });
    await expect(ale.decryptFieldsDeep({ x: 'arc.v1.garbage.a.b.!!!' })).rejects.toThrow(
      /malformed/,
    );
  });
});
