import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair, importPrivateKey, seal, open, fingerprint, fingerprintWords, isEnvelope, symSeal, symOpen, isSymBox } from "../src/crypto.js";
import { FINGERPRINT_WORDS } from "../src/words.js";
import { buildWorkflow, toPlistXml } from "../src/compose.js";
import { lint } from "../src/recipes.js";
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

/**
 * 지문 단어 — 서버(`server/test/fingerprint.test.ts`)·앱(`AskewTests/FingerprintWordsTests`)과
 * **같은 벡터**를 쓴다. 세 곳이 다른 단어를 보여 주면 지문 확인이라는 기능 자체가 무의미해진다.
 */
test("지문 단어: 고정 벡터가 서버·앱과 같다", () => {
  const key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
  assert.equal(fingerprint(key), "4bb0-6f8e-4e3a");
  assert.deepEqual(fingerprintWords(key), ["cider", "grove", "desert", "fever", "city", "burger"]);
  assert.equal(FINGERPRINT_WORDS.length, 256);
});

/**
 * 조립기 — **틀린 매개변수 키가 조용히 무시되는 것**이 이 기능의 유일한 진짜 위험이다.
 * 실행은 성공하고 값만 빠져서, 확신에 찬 틀린 답이 나온다(2026-09-19 반증 시험).
 * 그래서 검사기가 그걸 잡는지, 토큰 구조가 수확본과 같은지 고정한다.
 */
test("조립: 토큰 구조가 수확본과 같다", () => {
  const wf = buildWorkflow([
    { id: "b", action: "is.workflow.actions.getbatterylevel" },
    { id: "t", action: "is.workflow.actions.gettext",
      params: { WFTextActionText: { text: ["남은 ", { kind: "ref", of: "b", name: "배터리 잔량" }, "%"] } } },
    { action: "is.workflow.actions.output", params: { WFOutput: { text: [{ kind: "ref", of: "t", name: "텍스트" }] } } },
  ]);
  const acts = wf.WFWorkflowActions as any[];
  assert.equal(acts.length, 3);
  const txt = acts[1].WFWorkflowActionParameters.WFTextActionText;
  assert.equal(txt.WFSerializationType, "WFTextTokenString");
  // 토큰 자리는 U+FFFC 한 글자를 차지하고, 그 오프셋이 첨부 키가 된다.
  assert.equal(txt.Value.string, "남은 ￼%");
  assert.ok(txt.Value.attachmentsByRange["{3, 1}"], Object.keys(txt.Value.attachmentsByRange).join(","));
  // 참조는 앞 동작의 **실제 UUID**로 풀려야 한다 — 이름이 아니라.
  assert.equal(txt.Value.attachmentsByRange["{3, 1}"].OutputUUID, acts[0].WFWorkflowActionParameters.UUID);
});

test("조립: 없는 단계를 가리키면 던진다", () => {
  assert.throws(() => buildWorkflow([
    { action: "is.workflow.actions.gettext", params: { WFTextActionText: { text: [{ kind: "ref", of: "없음", name: "x" }] } } },
  ]), /없음/);
});

test("검사기: 틀린 매개변수 키를 잡고 쓸 수 있는 키를 알려 준다", async () => {
  const w = await lint([{ action: "is.workflow.actions.gettext", params: { WFTextActionTextWRONG: "x" } }]);
  assert.equal(w.length, 1);
  assert.match(w[0], /WFTextActionTextWRONG/);
  assert.match(w[0], /오류 없이 무시/);
  assert.match(w[0], /WFTextActionText/);      // 대안을 제시해야 쓸모가 있다
  assert.deepEqual(await lint([{ action: "is.workflow.actions.gettext", params: { WFTextActionText: "x" } }]), []);
});

test("XML plist가 서명 CLI가 받는 모양이다", () => {
  const xml = toPlistXml({ a: 1, b: true, c: ["x"], d: { e: "<&>" } });
  assert.ok(xml.startsWith('<?xml version="1.0"'));
  assert.match(xml, /<!DOCTYPE plist/);
  assert.match(xml, /<integer>1<\/integer>/);
  assert.match(xml, /<true\/>/);
  assert.match(xml, /&lt;&amp;&gt;/);          // 이스케이프 안 하면 plist가 깨진다
});
