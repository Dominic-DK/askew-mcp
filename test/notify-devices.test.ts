import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateKeys } from "../src/keys.js";
import { createToolHandlers, toolSchemas, type ToolContext } from "../src/tools.js";
import type { SelfInfo } from "../src/client.js";

// 2026-09-26: 기기가 여럿일 때 askew_notify가 조용히 전부에 뿌리던 기본값을 막는다(서버 DEVICE_REQUIRED와 같은 원칙).
const root = await mkdtemp(join(tmpdir(), "askew-notify-test-"));
after(() => rm(root, { recursive: true, force: true }));
const keys = await loadOrCreateKeys(join(root, "connector.key"));
const dev = (id: string) => ({ deviceId: id, publicKey: keys.publicKeyB64, fingerprint: "f", name: id, lastSeenAt: null });
function harness(n: number) {
  const sent: any[] = [];
  const snapshot = { connectorId: "c", stopped: false, name: "t", fingerprint: null, fingerprintWords: null, verified: true, verifiedAt: null,
    mode: "e2e", accountKey: null, devices: Array.from({ length: n }, (_, i) => dev(`d${i + 1}`)), routes: [] } as unknown as SelfInfo;
  const client = new Proxy({}, { get: (_, m) => async (p: any) => {
    if (m === "self") return snapshot;
    if (m === "createDelivery") { sent.push(p); return { id: "x", ids: p.targets.map((t: any) => t.deviceId) }; }
    throw new Error(`unexpected ${String(m)}`);
  } });
  return { sent, h: createToolHandlers({ client, keys } as ToolContext) };
}
const call = (x: ReturnType<typeof harness>, a: object) => x.h.askew_notify(toolSchemas.askew_notify.parse({ title: "t", body: "b", ...a }));

test("one device: deviceId may be omitted", async () => {
  const x = harness(1);
  const r = await call(x, {});
  assert.notEqual(r.isError, true);
  assert.deepEqual(x.sent[0].targets.map((t: any) => t.deviceId), ["d1"]);
});

test("several devices: no silent broadcast — DEVICE_REQUIRED and nothing is sent", async () => {
  const x = harness(2);
  const r = await call(x, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /DEVICE_REQUIRED/);
  assert.match(r.content[0]!.text, /d1.*d2/);
  assert.equal(x.sent.length, 0);
});

test("several devices: deviceId picks one, allDevices sends to all", async () => {
  const one = harness(2);
  await call(one, { deviceId: "d2" });
  assert.deepEqual(one.sent[0].targets.map((t: any) => t.deviceId), ["d2"]);
  const all = harness(2);
  await call(all, { allDevices: true });
  assert.deepEqual(all.sent[0].targets.map((t: any) => t.deviceId), ["d1", "d2"]);
});
