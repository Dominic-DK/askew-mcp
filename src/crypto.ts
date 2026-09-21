import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { FINGERPRINT_WORDS } from "./words.js";

export const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
export type Envelope = { v: 1; enc: string; ct: string };
export type Purpose = "job" | "result" | "delivery" | "inbox" | "hint" | "variable" | "accountkey" | "localrun";
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

/**
 * 지문을 **단어 6개**로. 같은 값을 16진수로도, 단어로도 보여 준다.
 *
 * 왜 단어인가: 지문 확인은 사람이 두 화면을 눈으로 맞춰 보는 일이다. `ab12-cd34-ef56`은
 * 한 글자 틀려도 안 틀린 것처럼 보이고, 전화로 불러 줄 수도 없다. 단어는 틀리면 티가 나고
 * 소리 내어 읽힌다. 단어표는 앞 3글자가 전부 달라서 흘려들어도 갈린다.
 *
 * 값은 16진수와 **같은 바이트**다 — SHA-256(공개키) 앞 6바이트, 바이트 하나가 단어 하나.
 * 그래서 둘 중 아무거나 비교해도 같은 확인이 된다.
 */
export function fingerprintWords(publicKeyB64: string): string[] {
  const h = createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest();
  return Array.from(h.subarray(0, 6), b => FINGERPRINT_WORDS[b]);
}
