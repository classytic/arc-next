/**
 * `@classytic/arc-next/encryption` — JWE helper for the client SDK.
 *
 * A ready-made `ClientEncryptionConfig` backed by `jose` (panva) — the same
 * library `@classytic/arc/encryption` uses server-side. Works in the browser
 * and Node (jose runs on Web Crypto). `jose` is an OPTIONAL peer: import this
 * subpath only when you want JWE; the core SDK pulls no crypto dependency.
 *
 * Asymmetric key model (mirrors Visa MLE / the arc backend plugin):
 *   - Decrypt RESPONSES with the client's PRIVATE key (the recipient).
 *   - Encrypt REQUESTS with the SERVER's PUBLIC key, tagged by `kid`.
 *
 * @example
 * ```ts
 * import { configureClient } from "@classytic/arc-next/client";
 * import { createJoseEncryption } from "@classytic/arc-next/encryption";
 * import { importPKCS8, importSPKI } from "jose";
 *
 * configureClient({
 *   baseUrl: "https://api.example.com",
 *   encryption: {
 *     ...createJoseEncryption({
 *       decryptionKeys: { "client-1": await importPKCS8(clientPrivPem, "RSA-OAEP-256") },
 *       encryptionKey: { kid: "server-1", key: await importSPKI(serverPubPem, "RSA-OAEP-256") },
 *     }),
 *     encryptRequests: true,
 *   },
 * });
 * ```
 */

import { CompactEncrypt, compactDecrypt } from "jose";
import type { ClientEncryptionConfig } from "./client.js";

/** Key material accepted by jose in browser + Node (Web Crypto). */
type JoseKey = CryptoKey | Uint8Array;

export interface JoseEncryptionOptions {
  /** Single decryption key (private/secret) used for every response. */
  decryptionKey?: JoseKey;
  /**
   * Decryption keys indexed by `kid` (rotation). When set, the inbound JWE's
   * `kid` header selects the key — keep 2–3 entries across a rotation so
   * in-flight responses signed with the previous `kid` still decrypt.
   */
  decryptionKeys?: Record<string, JoseKey>;
  /** Public/secret key + `kid` used to encrypt outbound requests. */
  encryptionKey?: { kid: string; key: JoseKey; alg?: string };
  /** Key-management algorithm. Default `'RSA-OAEP-256'`. */
  alg?: string;
  /** Content-encryption algorithm. Default `'A256GCM'`. */
  enc?: string;
  /** Inbound-decryption allowlists (anti-downgrade). Default `[alg]` / `[enc]`. */
  allowedAlgs?: string[];
  allowedEncs?: string[];
}

/**
 * Build the `encrypt` / `decrypt` half of a {@link ClientEncryptionConfig}
 * using `jose`. Spread the result into `encryption` and add `encryptRequests`
 * / content-type overrides as needed.
 */
export function createJoseEncryption(
  options: JoseEncryptionOptions,
): Pick<ClientEncryptionConfig, "encrypt" | "decrypt"> {
  const alg = options.alg ?? "RSA-OAEP-256";
  const enc = options.enc ?? "A256GCM";
  const allowedAlgs = options.allowedAlgs ?? [alg];
  const allowedEncs = options.allowedEncs ?? [enc];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const decrypt = async (payload: string): Promise<string> => {
    const { plaintext } = await compactDecrypt(
      payload,
      async (header) => {
        if (options.decryptionKeys) {
          const key = header.kid ? options.decryptionKeys[header.kid] : undefined;
          if (!key) {
            throw new Error(
              `[arc-next/encryption] no decryption key for kid '${header.kid ?? "<none>"}'`,
            );
          }
          return key;
        }
        if (!options.decryptionKey) {
          throw new Error("[arc-next/encryption] no decryption key configured");
        }
        return options.decryptionKey;
      },
      { keyManagementAlgorithms: allowedAlgs, contentEncryptionAlgorithms: allowedEncs },
    );
    return decoder.decode(plaintext);
  };

  const encryptionKey = options.encryptionKey;
  if (!encryptionKey) return { decrypt };

  const encrypt = async (json: string): Promise<string> =>
    new CompactEncrypt(encoder.encode(json))
      .setProtectedHeader({ alg: encryptionKey.alg ?? alg, enc, kid: encryptionKey.kid })
      .encrypt(encryptionKey.key);

  return { encrypt, decrypt };
}
