import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { generateKeyPair, importPrivateKey, fingerprint, fingerprintWords } from "./crypto.js";

export type ConnectorKeys = { privateKey: CryptoKey; publicKeyB64: string; fingerprint: string; words: string[]; created: boolean; path: string };

/** ~/.askew/connector.key — JSON {v:1, privateKey, publicKey} (X25519 raw base64), 첫 실행 때 생성, 0600 */
export async function loadOrCreateKeys(path = process.env.ASKEW_KEY_PATH ?? join(homedir(), ".askew", "connector.key")): Promise<ConnectorKeys> {
  let created = false;
  let rec: { v: number; privateKey: string; publicKey: string };
  if (existsSync(path)) {
    rec = JSON.parse(readFileSync(path, "utf8"));
    if (!rec?.privateKey || !rec?.publicKey) throw new Error(`키 파일 형식이 잘못됨: ${path}`);
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const kp = await generateKeyPair();
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify({ v: 1, privateKey: kp.privateKeyB64, publicKey: kp.publicKeyB64 }) + "\n");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // Publish a complete key without overwriting another process's winner.
      try { linkSync(temporary, path); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      // Windows does not expose directory fsync through Node. Local execution
      // (and its durable-journal guarantee) is macOS-only; relay keys still work.
      if (process.platform !== "win32") {
        const parent = openSync(dirname(path), "r");
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
      rec = JSON.parse(readFileSync(path, "utf8"));
      if (!rec?.privateKey || !rec?.publicKey) throw new Error(`키 파일 형식이 잘못됨: ${path}`);
    } finally { unlinkSync(temporary); }
  }
  const privateKey = await importPrivateKey(rec.privateKey);
  return { privateKey, publicKeyB64: rec.publicKey, fingerprint: fingerprint(rec.publicKey), words: fingerprintWords(rec.publicKey), created, path };
}
