import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { createToolHandlers, toolSchemas, type ToolContext } from "../src/tools.js";
import { createLocalRunner, type LocalCommand } from "../src/local-shortcuts.js";
import type { SelfInfo } from "../src/client.js";

function info(): SelfInfo {
  return { connectorId: "this-mac", stopped: false, name: "test", fingerprint: null, fingerprintWords: null,
    verified: true, verifiedAt: null, mode: "e2e", accountKey: null, devices: [],
    routes: [{ routeId: "r1", name: "echo", shortcutName: "에코", deviceId: "phone", executionMode: "auto", dataKinds: [],
      enabled: true, lastSuccessAt: null, createdAt: "", inputExample: '{"text":""}',
      targets: [{ kind: "connector", id: "this-mac", enabled: true, lastSuccessAt: null }] }] };
}
const args = () => toolSchemas.askew_run.parse({ routeId: "r1", target: { kind: "connector", id: "this-mac" }, input: { text: "PRIVATE_INPUT" } });
function harness(snapshot: SelfInfo, run: (name: string, input: string) => Promise<string>, platform = "darwin") {
  const calls: string[] = [];
  const client = new Proxy({}, { get: (_, method) => async () => {
    calls.push(String(method));
    if (method === "self") return snapshot;
    throw new Error(`Unexpected relay mutation/read: ${String(method)}`);
  } });
  return { calls, handlers: createToolHandlers({ client } as ToolContext, { localRun: run, platform }) };
}

test("assigned local target returns local result with no relay job/quota/result upload", async () => {
  const executions: [string, string][] = [];
  const h = harness(info(), async (name, input) => { executions.push([name, input]); return "PRIVATE_OUTPUT"; });
  const result = await h.handlers.askew_run(args());
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(executions, [["에코", '{"text":"PRIVATE_INPUT"}']]);
  assert.deepEqual(h.calls, ["self"]);
  assert.match(result.content[0]!.text, /status: done/);
  assert.match(result.content[0]!.text, /PRIVATE_OUTPUT/);
  assert.doesNotMatch(result.content[0]!.text, /jobId:/);
});

test("local target checks authorization, stop state, confirm mode and idempotency before effects", async () => {
  const cases: [string, (s: SelfInfo, a: ReturnType<typeof args>) => void, string][] = [
    ["other Mac", (s, a) => { a.target!.id = "other-mac"; s.routes[0]!.targets!.push({ kind: "connector", id: "other-mac", enabled: true, lastSuccessAt: null }); }, "LOCAL_TARGET_MISMATCH"],
    ["missing target metadata", s => { delete s.routes[0]!.targets; }, "LOCAL_TARGET_UNAUTHORIZED"],
    ["unassigned", s => { s.routes[0]!.targets = []; }, "TARGET_REQUIRED"],
    ["disabled target", s => { s.routes[0]!.targets![0]!.enabled = false; }, "TARGET_REQUIRED"],
    ["disabled route", s => { s.routes[0]!.enabled = false; }, "비활성"],
    ["emergency stop", s => { s.stopped = true; }, "ACCOUNT_STOPPED"],
    ["unknown stop state", s => { delete s.stopped; }, "LOCAL_STOP_STATE_UNKNOWN"],
    ["confirm route", s => { s.routes[0]!.executionMode = "confirm"; }, "LOCAL_CONFIRM_REQUIRED"],
    ["idempotency", (_, a) => { a.idempotencyKey = "attempt-1"; }, "LOCAL_IDEMPOTENCY_UNSUPPORTED"],
    ["empty idempotency key", (_, a) => { a.idempotencyKey = ""; }, "LOCAL_IDEMPOTENCY_UNSUPPORTED"],
    ["input contract", (_, a) => { a.input = { other: "wrong" }; }, "Input rejected"],
    ["route id wins over name", (_, a) => { a.routeId = "missing"; a.routeName = "echo"; }, "라우트를 찾지 못함"],
  ];
  for (const [label, modify, expected] of cases) {
    const snapshot = info(), a = args(); modify(snapshot, a);
    let ran = false;
    const h = harness(snapshot, async () => { ran = true; return ""; });
    const result = await h.handlers.askew_run(a);
    assert.equal(result.isError, true, label);
    assert.ok(result.content[0]!.text.includes(expected), `${label}: ${result.content[0]!.text}`);
    assert.equal(ran, false, label);
    assert.deepEqual(h.calls, ["self"], label);
  }
});

test("local execution platform guard and failures never fall back to phone or retry", async () => {
  let ran = 0;
  const wrongPlatform = harness(info(), async () => { ran++; return ""; }, "linux");
  const unsupported = await wrongPlatform.handlers.askew_run(args());
  assert.equal(unsupported.isError, true); assert.match(unsupported.content[0]!.text, /LOCAL_UNSUPPORTED/);
  assert.equal(ran, 0);
  const failed = harness(info(), async () => { ran++; throw new Error("LOCAL_TIMEOUT: effects may already have happened"); });
  const result = await failed.handlers.askew_run(args());
  assert.equal(result.isError, true); assert.equal(ran, 1); assert.deepEqual(failed.calls, ["self"]);
});

const ID = "12345678-1234-1234-1234-123456789abc";
test("local process runner normalizes names, runs UUID once with file arguments, then removes private temp files", async () => {
  const commands: string[][] = [];
  let dir = "";
  const exec: LocalCommand = async (a) => {
    commands.push(a);
    if (a[0] === "list") return { code: 0, stdout: `${"에코".normalize("NFD")} (${ID})\n`, stderr: "" };
    assert.equal(a[1], ID);
    assert.equal(await readFile(a[3]!, "utf8"), "sensitive input; $(not a shell)");
    dir = dirname(a[3]!);
    await writeFile(a[5]!, "local output");
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await createLocalRunner({ platform: "darwin", exec })("에코", "sensitive input; $(not a shell)");
  assert.equal(result, "local output");
  assert.equal(commands.filter(a => a[0] === "run").length, 1);
  await assert.rejects(access(dir), { code: "ENOENT" });
});

test("local process runner rejects missing/ambiguous/malformed names and non-Mac without executing", async () => {
  for (const stdout of ["", `에코 (${ID})\n에코 (${ID})`, "에코 (--malicious-argument)"]) {
    let runs = 0;
    const run = createLocalRunner({ platform: "darwin", exec: async a => {
      if (a[0] === "run") runs++;
      return { code: 0, stdout, stderr: "" };
    } });
    await assert.rejects(run("에코", ""), /LOCAL_NOT_FOUND|LOCAL_AMBIGUOUS/); assert.equal(runs, 0);
  }
  let commands = 0;
  await assert.rejects(createLocalRunner({ platform: "linux", exec: async () => { commands++; return { code: 0, stdout: "", stderr: "" }; } })("에코", ""), /LOCAL_UNSUPPORTED/);
  assert.equal(commands, 0);
});

test("local timeout and process failure clean temp files and warn against retry", async () => {
  for (const timedOut of [true, false]) {
    let count = 0, dir = "";
    const run = createLocalRunner({ platform: "darwin", exec: async a => {
      if (a[0] === "list") return { code: 0, stdout: `에코 (${ID})`, stderr: "" };
      count++; dir = dirname(a[3]!);
      return { code: 1, stdout: "", stderr: "test failure", timedOut };
    } });
    await assert.rejects(run("에코", ""), error => {
      assert.match(String(error), timedOut ? /LOCAL_TIMEOUT/ : /LOCAL_RUN_FAILED/);
      assert.match(String(error), /자동 재시도하지/); return true;
    });
    assert.equal(count, 1); await assert.rejects(access(dir), { code: "ENOENT" });
  }
});
