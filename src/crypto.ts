import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
export type Envelope = { v: 1; enc: string; ct: string };
export type Purpose = "job" | "result" | "delivery" | "inbox" | "hint" | "variable" | "accountkey";
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

/** 계정 키(32바이트 대칭키)로 잠근 값 — 변수용. ChaCha20-Poly1305, nonce 12바이트, AAD = 변수 이름. ct = 암호문 || 태그(16). */
export type SymBox = { v: 1; alg: "chacha20poly1305"; nonce: string; ct: string };
export function isSymBox(x: unknown): x is SymBox {
  return !!x && typeof x === "object" && (x as any).v === 1 && (x as any).alg === "chacha20poly1305" && typeof (x as any).nonce === "string" && typeof (x as any).ct === "string";
}
export function symSeal(key: Uint8Array, aad: string, plaintext: string): SymBox {
  if (key.length !== 32) throw new Error("account key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"), { plaintextLength: Buffer.byteLength(plaintext, "utf8") });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, alg: "chacha20poly1305", nonce: nonce.toString("base64"), ct: ct.toString("base64") };
}
export function symOpen(key: Uint8Array, aad: string, box: SymBox): string {
  if (key.length !== 32) throw new Error("account key must be 32 bytes");
  const data = Buffer.from(box.ct, "base64");
  if (data.length < 16) throw new Error("ciphertext too short");
  const ct = data.subarray(0, data.length - 16), tag = data.subarray(data.length - 16);
  const d = createDecipheriv("chacha20-poly1305", key, Buffer.from(box.nonce, "base64"), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, "utf8"), { plaintextLength: ct.length });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
