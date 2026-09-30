import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, interpretProbe, renderCatalog } from "../src/setup.js";
import type { SelfInfo, CatalogRecipe, JobView } from "../src/client.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const route = (name: string, shortcutName: string, extra: Record<string, unknown> = {}) => ({
  routeId: "rt_" + name, name, shortcutName, executionMode: "auto" as const, dataKinds: [], deviceId: "d1", enabled: true,
  lastSuccessAt: "2026-09-30T06:00:00Z", createdAt: "2026-09-01T00:00:00Z", inputExample: "{}", ...extra });
const info = (routes: any[], extra: Partial<SelfInfo> = {}): SelfInfo => ({
  stopped: false, connectorId: "c1", name: "맥북", fingerprint: "aaaa", fingerprintWords: ["a", "b"], verified: true, verifiedAt: null,
  mode: "e2e", accountKey: { v: 1, enc: "x", ct: "y" },
  devices: [{ deviceId: "d1", publicKey: "k", fingerprint: "f", name: "iPhone", lastSeenAt: "2026-09-30T11:00:00Z" }], routes, ...extra });
const catalog: CatalogRecipe[] = [
  { id: "calendar.add", kind: "route", route: "calendar.add", name: "캘린더에 넣기", shortcutName: "calendar-add", audience: "agent" },
  { id: "device.status", kind: "route", route: "device.status", name: "기기 상태", shortcutName: "device-status", audience: "both" },
];

test("a route still pointing at the old Korean Shortcut name is a FAIL with the reinstall fix (2026-09-30 case)", () => {
  const f = diagnose(info([route("calendar.add", "캘린더에 넣기"), route("device.status", "device-status")]), catalog, NOW);
  const bad = f.find(x => x.level === "fail");
  assert.ok(bad, JSON.stringify(f));
  assert.match(bad!.text, /calendar\.add calls Shortcut "캘린더에 넣기" but the current recipe installs "calendar-add"/);
});

test("a clean setup has no problems; never-succeeded routes and stale devices are warnings", () => {
  assert.equal(diagnose(info([route("device.status", "device-status")]), catalog, NOW).filter(x => x.level !== "ok").length, 0);
  const f = diagnose(info([route("device.status", "device-status", { lastSuccessAt: null })], {
    devices: [{ deviceId: "d1", publicKey: "k", fingerprint: "f", name: "iPhone", lastSeenAt: "2026-09-01T00:00:00Z" }] }), catalog, NOW);
  assert.ok(f.some(x => x.level === "warn" && /never succeeded/.test(x.text)));
  assert.ok(f.some(x => x.level === "warn" && /29 days ago/.test(x.text)));
});

test("no routes, no devices, unverified and server mode are called out", () => {
  const f = diagnose(info([], { devices: [], verified: false, mode: "server" }), catalog, NOW);
  const fails = f.filter(x => x.level === "fail").map(x => x.text).join("\n");
  assert.match(fails, /mode=server/); assert.match(fails, /No phone/); assert.match(fails, /No routes installed/);
  assert.ok(f.some(x => x.level === "warn" && /Words match/.test(x.text)));
});

const job = (status: string, steps: string[], error?: string): JobView => ({ jobId: "job_1", status, routeId: "r", createdAt: "",
  error, timeline: steps.map(step => ({ step, at: "2026-09-30T06:00:00Z", by: "server" })) });

test("probe verdict separates 'dispatcher never started' from 'target Shortcut did not answer'", () => {
  assert.equal(interpretProbe(job("done", ["received", "pushed", "started", "result"])).level, "ok");
  assert.match(interpretProbe(job("expired", ["received", "pushed"])).text, /never started it[\s\S]*automation is ON/);
  assert.match(interpretProbe(job("unknown", ["received", "pushed", "started"])).text, /missing or renamed[\s\S]*Always Allow/);
  assert.match(interpretProbe(job("failed", ["received", "pushed", "started"], "권한 없음")).text, /권한 없음/);
});

test("catalog marks installed / outdated / missing recipes", () => {
  const t = renderCatalog(catalog, info([route("calendar.add", "캘린더에 넣기")]), undefined);
  assert.match(t, /calendar\.add .* installed=OUTDATED \(route calls "캘린더에 넣기"\)/);
  assert.match(t, /device\.status .* installed=no/);
  assert.match(renderCatalog(catalog, null, "기기"), /1 recipe\(s\)[\s\S]*device\.status/);
});
