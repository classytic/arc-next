// @vitest-environment node
//
// jose + TextEncoder must share a realm: under jsdom, `TextEncoder().encode()`
// yields a jsdom-realm Uint8Array that jose's Node build rejects
// ("plaintext must be an instance of Uint8Array"). In a real browser both come
// from the same realm, so node env is the faithful test environment here.
/**
 * Application-Layer Encryption — client SDK.
 *
 * Round-trips against the real `jose` helper: the mock server encrypts
 * responses with the client's PUBLIC key (client decrypts with its PRIVATE
 * key), and request encryption is verified by decrypting the sent body with
 * the server's PRIVATE key. Proves the SDK decrypts `application/jose`
 * responses transparently and encrypts outbound JSON when opted in.
 */
import { CompactEncrypt, compactDecrypt, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureClient, handleApiRequest } from "../src/client.js";
import { createJoseEncryption } from "../src/encryption.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let clientPub: CryptoKey;
let clientPriv: CryptoKey;
let serverPub: CryptoKey;
let serverPriv: CryptoKey;

beforeAll(async () => {
  const client = await generateKeyPair("RSA-OAEP-256");
  const server = await generateKeyPair("RSA-OAEP-256");
  clientPub = client.publicKey as CryptoKey;
  clientPriv = client.privateKey as CryptoKey;
  serverPub = server.publicKey as CryptoKey;
  serverPriv = server.privateKey as CryptoKey;
});

let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchMock.mockRestore();
});

/** Encrypt a JSON value as a JWE the SDK will decrypt (with the client key). */
async function encryptForClient(value: unknown): Promise<string> {
  return new CompactEncrypt(encoder.encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM", kid: "client-1" })
    .encrypt(clientPub);
}

describe("createJoseEncryption", () => {
  it("round-trips encrypt → decrypt with a single key pair", async () => {
    const enc = createJoseEncryption({
      decryptionKeys: { k1: serverPriv },
      encryptionKey: { kid: "k1", key: serverPub },
    });
    const jwe = await enc.encrypt!(JSON.stringify({ hello: "world" }));
    expect(jwe).not.toContain("world");
    expect(await enc.decrypt(jwe)).toBe(JSON.stringify({ hello: "world" }));
  });

  it("omits encrypt when no encryptionKey is given", () => {
    const enc = createJoseEncryption({ decryptionKey: clientPriv });
    expect(enc.encrypt).toBeUndefined();
    expect(typeof enc.decrypt).toBe("function");
  });
});

describe("client encryption — response decryption", () => {
  it("decrypts an application/jose response transparently", async () => {
    configureClient({
      baseUrl: "http://api.test",
      encryption: createJoseEncryption({ decryptionKeys: { "client-1": clientPriv } }),
    });

    const jwe = await encryptForClient({ ssn: "123-45-6789", name: "Jane" });
    fetchMock.mockResolvedValue(
      new Response(jwe, { status: 200, headers: { "Content-Type": "application/jose" } }),
    );

    const result = await handleApiRequest("GET", "/secret");
    expect(result).toEqual({ ssn: "123-45-6789", name: "Jane" });
  });

  it("leaves plain application/json responses untouched", async () => {
    configureClient({
      baseUrl: "http://api.test",
      encryption: createJoseEncryption({ decryptionKeys: { "client-1": clientPriv } }),
    });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(await handleApiRequest("GET", "/public")).toEqual({ ok: true });
  });
});

describe("client encryption — request encryption", () => {
  it("encrypts the outbound JSON body and flips Content-Type", async () => {
    configureClient({
      baseUrl: "http://api.test",
      encryption: {
        ...createJoseEncryption({
          decryptionKeys: { "client-1": clientPriv },
          encryptionKey: { kid: "server-1", key: serverPub },
        }),
        encryptRequests: true,
      },
    });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await handleApiRequest("POST", "/pay", { body: { amount: 100, card: "4111" } });

    const [, options] = fetchMock.mock.calls[0]!;
    const init = options as RequestInit;
    const sentBody = init.body as string;
    const headers = init.headers as Record<string, string>;

    expect(headers["Content-Type"]).toBe("application/jose");
    expect(typeof sentBody).toBe("string");
    expect(sentBody).not.toContain("4111"); // ciphertext, not plaintext

    // The server (holding its private key) can recover the original body.
    const { plaintext } = await compactDecrypt(sentBody, serverPriv);
    expect(JSON.parse(decoder.decode(plaintext))).toEqual({ amount: 100, card: "4111" });
  });

  it("does not encrypt requests when encryptRequests is false", async () => {
    configureClient({
      baseUrl: "http://api.test",
      encryption: createJoseEncryption({
        decryptionKeys: { "client-1": clientPriv },
        encryptionKey: { kid: "server-1", key: serverPub },
      }),
    });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await handleApiRequest("POST", "/pay", { body: { amount: 100 } });

    const [, options] = fetchMock.mock.calls[0]!;
    const init = options as RequestInit;
    expect(init.body).toBe(JSON.stringify({ amount: 100 })); // plaintext JSON
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
