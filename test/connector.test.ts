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
import { generateKeyPair, importPrivateKey, seal, open } from "../src/crypto.js";

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
  (srv as any).closeAllConnections?.();
  srv.close();
  db.close();
});
