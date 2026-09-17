import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { createHash } from "node:crypto";

export const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
export type Envelope = { v: 1; enc: string; ct: string };
export type Purpose = "job" | "result" | "delivery" | "inbox" | "hint" | "variable";
const infoFor = (p: Purpose) => new TextEncoder().encode(`askew:v1:${p}`);
const b64 = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const toAB = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export async function seal(recipientPublicKeyB64: string, purpose: Purpose, plaintext: string | Uint8Array): Promise<Envelope> {
  const pk = await suite.kem.deserializePublicKey(toAB(unb64(recipientPublicKeyB64)));
  const ctx = await suite.createSenderContext({ recipientPublicKey: pk, info: infoFor(purpose) });
  const pt = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const ct = await ctx.seal(toAB(pt));
  return { v: 1, enc: b64(ctx.enc), ct: b64(ct) };
}
export async function open(privateKey: CryptoKey, purpose: Purpose, env: Envelope): Promise<string> {
  const ctx = await suite.createRecipientContext({ recipientKey: privateKey, enc: toAB(unb64(env.enc)), info: infoFor(purpose) });
  return new TextDecoder().decode(await ctx.open(toAB(unb64(env.ct))));
}
export async function generateKeyPair() {
  const kp = await suite.kem.generateKeyPair();
  return { publicKeyB64: b64(await suite.kem.serializePublicKey(kp.publicKey)), privateKeyB64: b64(await suite.kem.serializePrivateKey(kp.privateKey)) };
}
export async function importPrivateKey(privateKeyB64: string): Promise<CryptoKey> {
  return suite.kem.deserializePrivateKey(toAB(unb64(privateKeyB64)));
}
export function fingerprint(publicKeyB64: string): string {
  const h = createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex");
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}
export function isEnvelope(x: unknown): x is Envelope {
  return !!x && typeof x === "object" && (x as any).v === 1 && typeof (x as any).enc === "string" && typeof (x as any).ct === "string";
}
