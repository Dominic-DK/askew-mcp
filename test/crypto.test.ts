import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair, importPrivateKey, seal, open, fingerprint, isEnvelope, symSeal, symOpen, isSymBox } from "../src/crypto.js";
import { loadOrCreateKeys } from "../src/keys.js";

test("HPKE seal → open round-trips and binds the purpose", async () => {
  const kp = await generateKeyPair();
  const priv = await importPrivateKey(kp.privateKeyB64);
  const env = await seal(kp.publicKeyB64, "job", JSON.stringify({ title: "dentist Thu 3pm" }));
  assert.ok(isEnvelope(env));
  assert.equal(env.v, 1);
  assert.notEqual(env.ct, "");
  assert.deepEqual(JSON.parse(await open(priv, "job", env)), { title: "dentist Thu 3pm" });
  // same envelope opened under a different purpose (HPKE info) must fail
  await assert.rejects(open(priv, "result", env));
  // a different recipient key must fail
  const other = await importPrivateKey((await generateKeyPair()).privateKeyB64);
  await assert.rejects(open(other, "job", env));
});

test("HPKE seal accepts bytes and each seal produces a fresh enc", async () => {
  const kp = await generateKeyPair();
  const priv = await importPrivateKey(kp.privateKeyB64);
  const a = await seal(kp.publicKeyB64, "inbox", new TextEncoder().encode("bytes"));
  const b = await seal(kp.publicKeyB64, "inbox", "bytes");
  assert.notEqual(a.enc, b.enc);
  assert.equal(await open(priv, "inbox", a), "bytes");
  assert.equal(await open(priv, "inbox", b), "bytes");
});

test("fingerprint is stable and formatted xxxx-xxxx-xxxx", async () => {
  const kp = await generateKeyPair();
  const fp = fingerprint(kp.publicKeyB64);
  assert.match(fp, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal(fingerprint(kp.publicKeyB64), fp);
  assert.notEqual(fingerprint((await generateKeyPair()).publicKeyB64), fp);
});

test("account-key SymBox round-trips and the name is authenticated (AAD)", () => {
  const key = new Uint8Array(randomBytes(32));
  const box = symSeal(key, "home", JSON.stringify({ city: "Seoul", floor: 12 }));
  assert.ok(isSymBox(box));
  assert.equal(box.alg, "chacha20poly1305");
  assert.deepEqual(JSON.parse(symOpen(key, "home", box)), { city: "Seoul", floor: 12 });
  assert.throws(() => symOpen(key, "other", box));
  assert.throws(() => symOpen(new Uint8Array(randomBytes(32)), "home", box));
  assert.throws(() => symSeal(new Uint8Array(16), "home", "x"), /32 bytes/);
  assert.throws(() => symOpen(key, "home", { ...box, ct: Buffer.from("short").toString("base64") }), /too short/);
});

test("isEnvelope / isSymBox reject foreign shapes", () => {
  assert.equal(isEnvelope(null), false);
  assert.equal(isEnvelope({ v: 2, enc: "a", ct: "b" }), false);
  assert.equal(isEnvelope({ v: 1, enc: "a" }), false);
  assert.equal(isSymBox({ v: 1, alg: "aes", nonce: "a", ct: "b" }), false);
});

test("loadOrCreateKeys creates a 0600 key file once and reloads the same key", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "askew-mcp-test-")), "connector.key");
  const first = await loadOrCreateKeys(path);
  assert.equal(first.created, true);
  assert.equal(first.path, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(rec.v, 1);
  assert.equal(rec.publicKey, first.publicKeyB64);
  const second = await loadOrCreateKeys(path);
  assert.equal(second.created, false);
  assert.equal(second.publicKeyB64, first.publicKeyB64);
  assert.equal(second.fingerprint, first.fingerprint);
  // the reloaded private key opens what was sealed to the public key
  const env = await seal(first.publicKeyB64, "variable", "still mine");
  assert.equal(await open(second.privateKey, "variable", env), "still mine");
});
