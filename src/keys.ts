import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { generateKeyPair, importPrivateKey, fingerprint } from "./crypto.js";

export type ConnectorKeys = { privateKey: CryptoKey; publicKeyB64: string; fingerprint: string; created: boolean; path: string };

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
    rec = { v: 1, privateKey: kp.privateKeyB64, publicKey: kp.publicKeyB64 };
    writeFileSync(path, JSON.stringify(rec) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    created = true;
  }
  const privateKey = await importPrivateKey(rec.privateKey);
  return { privateKey, publicKeyB64: rec.publicKey, fingerprint: fingerprint(rec.publicKey), created, path };
}
