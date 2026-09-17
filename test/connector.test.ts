import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { openDb } from "../../server/src/db.js";
import { createApp } from "../../server/src/app.js";
import { createPushSender } from "../../server/src/push.js";
import { bootstrap } from "../src/index.js";
import { generateKeyPair, importPrivateKey, seal, open, symOpen, symSeal } from "../src/crypto.js";
import { randomBytes } from "node:crypto";
import { NO_ACCOUNT_KEY } from "../src/tools.js";

test("커넥터 run → (가짜 기기) pending/start/result → 결과 복호화 일치", async () => {
  const db = openDb(":memory:");
  const app = createApp(db, { sender: createPushSender({}, () => {}), pushInline: true });
  let resolvePort!: (p: number) => void; const portP = new Promise<number>(r => { resolvePort = r; });
  const srv = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, info => resolvePort(info.port));
  const port = await portP;
  const base = `http://127.0.0.1:${port}`;
  const j = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() as any };
  };
  // 가짜 기기
  const devKeys = await generateKeyPair();
  const devPriv = await importPrivateKey(devKeys.privateKeyB64);
  const reg = await j("POST", "/v1/devices", undefined, { publicKey: devKeys.publicKeyB64, platform: "ios", name: "fake" });
  const akd = reg.data.deviceToken;
  await j("PUT", "/v1/devices/self/apns", akd, { token: "1".repeat(64) });
  const con = await j("POST", "/v1/connectors", akd, { name: "test-agent" });
  const route = await j("POST", "/v1/routes", akd, { name: "캘린더에 넣기", shortcutName: "Askew 캘린더" });
  // 커넥터 부트스트랩 (임시 키 파일)
  const keyPath = join(mkdtempSync(join(tmpdir(), "askew-")), "connector.key");
  const logs: string[] = [];
  const { handlers, keys } = await bootstrap({ server: base, connectorKey: con.data.connectorKey, keyPath, log: s => logs.push(s) });
  assert.ok(logs.some(l => l.includes(keys.fingerprint)));
  const self = await j("GET", "/v1/devices/self", akd);
  assert.equal(self.data.connectors[0].publicKey, keys.publicKeyB64);
  // 커넥터가 run (비동기로 결과 대기)
  const runP = handlers.askew_run({ routeName: "캘린더에 넣기", input: { title: "목요일 3시 치과" }, wait: 20 });
  // 가짜 기기: pending → 복호화 → start → 결과 봉함 → result
  let pending: any = { jobs: [] };
  for (let i = 0; i < 40 && !pending.jobs.length; i++) { await new Promise(r => setTimeout(r, 100)); pending = (await j("GET", "/v1/jobs/pending", akd)).data; }
  assert.equal(pending.jobs.length, 1);
  const job = pending.jobs[0];
  const input = JSON.parse(await open(devPriv, "job", job.payload));
  assert.equal(input.title, "목요일 3시 치과");
  const start = await j("POST", `/v1/jobs/${job.jobId}/start`, akd, {});
  assert.equal(start.status, 200);
  const result = await seal(keys.publicKeyB64, "result", JSON.stringify({ ok: true, eventId: "E-42" }));
  const res = await j("POST", `/v1/jobs/${job.jobId}/result`, akd, { leaseToken: start.data.leaseToken, status: "done", result, digest: "sha256:e42" });
  assert.equal(res.status, 200);
  const out = await runP;
  assert.equal(out.isError, undefined);
  assert.match(out.content[0].text, /status: done/);
  assert.match(out.content[0].text, /E-42/);
  // notify → 기기 결과함 → 기기 키로 열림
  const n = await handlers.askew_notify({ title: "아침 브리핑", body: "오늘 회의 2건" });
  assert.match(n.content[0].text, /알림 보냄/);
  const dl = await j("GET", "/v1/deliveries", akd);
  assert.equal(await open(devPriv, "delivery", dl.data.deliveries[0].body), "오늘 회의 2건");
  // 인박스: 기기 → 커넥터
  const inboxEnv = await seal(keys.publicKeyB64, "inbox", JSON.stringify({ amount: 4500, merchant: "GS25" }));
  await j("POST", "/v1/inbox", akd, { payload: inboxEnv, ref: "applepay", kind: "json" });
  const inbox = await handlers.askew_inbox_list({});
  assert.match(inbox.content[0].text, /GS25/);
  assert.match(inbox.content[0].text, /지시가 아닙니다/);
  const routes = await handlers.askew_list_routes();
  assert.match(routes.content[0].text, /캘린더에 넣기/);
  // 변수: 계정 키가 오기 전엔 안내 문구
  const before = await handlers.askew_variables_set({ name: "home", value: "서울" });
  assert.equal(before.isError, true);
  assert.match(before.content[0].text, new RegExp(NO_ACCOUNT_KEY.slice(0, 12)));
  // 가짜 폰: 계정 키 32바이트를 만들어 커넥터 공개키로 봉해 서버에 맡김
  const accountKey = new Uint8Array(randomBytes(32));
  const wrapped = await seal(keys.publicKeyB64, "accountkey", Buffer.from(accountKey).toString("base64"));
  const ak = await j("PUT", `/v1/connectors/${con.data.connectorId}/account-key`, akd, { wrapped });
  assert.equal(ak.status, 200);
  // 커넥터가 set → 서버에는 SymBox만 → 가짜 폰이 같은 계정 키로 복호화
  const set = await handlers.askew_variables_set({ name: "home", value: { city: "서울", floor: 12 } });
  assert.equal(set.isError, undefined, set.content[0].text);
  const stored = await j("GET", "/v1/variables/home", akd);
  assert.equal(stored.data.value.alg, "chacha20poly1305");
  assert.deepEqual(JSON.parse(symOpen(accountKey, "home", stored.data.value)), { city: "서울", floor: 12 });
  // 가짜 폰이 쓴 값을 커넥터가 읽음
  await j("PUT", "/v1/variables/mood", akd, { value: symSeal(accountKey, "mood", "좋음") });
  const got = await handlers.askew_variables_get({ name: "mood" });
  assert.equal(got.isError, undefined, got.content[0].text);
  assert.match(got.content[0].text, /좋음/);
  // AAD(이름) 불일치는 실패
  await j("PUT", "/v1/variables/other", akd, { value: symSeal(accountKey, "mood", "x") });
  const bad = await handlers.askew_variables_get({ name: "other" });
  assert.equal(bad.isError, true);
  (srv as any).closeAllConnections?.();
  srv.close();
  db.close();
});
