import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadOrCreateKeys } from "../src/keys.js";
import { DurableLocalJournal, type LocalRunRequest } from "../src/local-journal.js";

const request: LocalRunRequest = { connectorId: "mac", routeId: "route", shortcutName: "Private Shortcut",
  input: { message: "PRIVATE_INPUT", nested: { b: 2, a: 1 } }, idempotencyKey: "PRIVATE_KEY" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "askew-journal-test-"));
  const keys = await loadOrCreateKeys(join(directory, "connector.key"));
  const root = join(directory, "local-runs");
  return { directory, keys, root, journal: new DurableLocalJournal(keys, root),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("journal survives restart, canonicalizes object keys, and encrypts all private metadata/results", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    const first = await f.journal.run(request, async () => { executions++; return "PRIVATE_OUTPUT"; });
    assert.equal(first.record.status, "done");
    const restarted = new DurableLocalJournal(await loadOrCreateKeys(f.keys.path), f.root);
    const repeated = await restarted.run({ ...request, input: { nested: { a: 1, b: 2 }, message: "PRIVATE_INPUT" } },
      async () => { executions++; return "incorrect"; });
    assert.equal(executions, 1);
    assert.equal(repeated.replayed, true);
    assert.deepEqual(repeated.record, first.record);
    const scopes = await readdir(f.root);
    const files = await readdir(join(f.root, scopes[0]!));
    assert.equal(files.length, 1);
    const path = join(f.root, scopes[0]!, files[0]!);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.root, scopes[0]!))).mode & 0o777, 0o700);
    assert.doesNotMatch(await readFile(path, "utf8"), /PRIVATE_|Private Shortcut|route|done/);
    for (const changed of [{ input: { message: "new" } }, { routeId: "other" }, { shortcutName: "renamed" }]) {
      await assert.rejects(restarted.run({ ...request, ...changed }, async () => { executions++; return ""; }), /LOCAL_IDEMPOTENCY_CONFLICT/);
    }
    assert.equal(executions, 1);
  } finally { await f.cleanup(); }
});

test("reservation visible before dispatch blocks concurrent duplicate runs and keeps uncertain effects unknown", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = f.journal.run(request, async () => { executions++; started(); await hold; throw new Error("effect happened, response lost"); });
    await began;
    const concurrent = await new DurableLocalJournal(f.keys, f.root).run(request, async () => { executions++; return "bad retry"; });
    assert.equal(concurrent.record.status, "unknown");
    assert.equal(concurrent.replayed, true);
    assert.equal(concurrent.record.finishedAt, undefined);
    release();
    const ended = await first;
    assert.equal(ended.record.status, "unknown");
    assert.match(ended.record.error!, /response lost/);
    const later = await new DurableLocalJournal(f.keys, f.root).run(request, async () => { executions++; return "bad retry"; });
    assert.equal(later.record.status, "unknown");
    assert.equal(executions, 1);
  } finally { await f.cleanup(); }
});

test("record corruption or unavailable journal fails closed without executing", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    await f.journal.run(request, async () => { executions++; return "OK"; });
    const scope = (await readdir(f.root))[0]!;
    const file = (await readdir(join(f.root, scope)))[0]!;
    await writeFile(join(f.root, scope, file), "{partial reservation");
    await assert.rejects(f.journal.run(request, async () => { executions++; return "bad"; }), /LOCAL_JOURNAL_UNREADABLE/);
    const invalidRoot = join(f.directory, "not-a-directory");
    await writeFile(invalidRoot, "occupied");
    await assert.rejects(new DurableLocalJournal(f.keys, invalidRoot).run(request, async () => { executions++; return "bad"; }));
    assert.equal(executions, 1);
  } finally { await f.cleanup(); }
});

test("journal IDs are connector scoped, keyless requests stay separate, and path traversal is rejected", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    const run = async () => { executions++; return "OK"; };
    const a = await f.journal.run(request, run);
    const b = await f.journal.run({ ...request, connectorId: "another" }, run);
    assert.notEqual(a.record.jobId, b.record.jobId);
    await assert.rejects(f.journal.get("another", a.record.jobId), /LOCAL_RUN_NOT_FOUND/);
    for (const id of ["../connector.key", "local_../connector.key", "local_"]) await assert.rejects(f.journal.get("mac", id), /LOCAL_RUN_ID_INVALID/);
    const one = await f.journal.run({ ...request, idempotencyKey: undefined }, run);
    const two = await f.journal.run({ ...request, idempotencyKey: undefined }, run);
    assert.notEqual(one.record.jobId, two.record.jobId);
    for (const key of ["", "x".repeat(201)]) await assert.rejects(f.journal.run({ ...request, idempotencyKey: key }, run), /LOCAL_IDEMPOTENCY_INVALID/);
    assert.equal(executions, 4);
  } finally { await f.cleanup(); }
});

test("SIGKILL after dispatch leaves a durable unknown reservation across process restart", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/local-journal-crash.ts", import.meta.url)), f.directory],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Child exited ${code}: ${stderr}`)));
    });
    const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await stopped;
    let executed = false;
    const afterCrash = await new DurableLocalJournal(await loadOrCreateKeys(f.keys.path)).run({ connectorId: "mac", routeId: "route",
      shortcutName: "test", input: "test", idempotencyKey: "crashed-attempt" }, async () => { executed = true; return "bad"; });
    assert.equal(executed, false);
    assert.equal(afterCrash.replayed, true);
    assert.equal(afterCrash.record.status, "unknown");
    assert.equal(afterCrash.record.finishedAt, undefined);
  } finally { child.kill("SIGKILL"); await f.cleanup(); }
});

test("concurrent first-time key initialization shares one key and one idempotent execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "askew-key-race-"));
  try {
    const keyPath = join(directory, "connector.key");
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateKeys(keyPath)));
    assert.equal(new Set(keys.map(k => k.publicKeyB64)).size, 1);
    assert.equal(keys.filter(k => k.created).length, 1);
    let executions = 0;
    const results = await Promise.allSettled(keys.map(k => new DurableLocalJournal(k).run(request, async () => { executions++; return "OK"; })));
    assert.equal(executions, 1);
    assert.equal(results.filter(r => r.status === "fulfilled" && !r.value.replayed).length, 1);
    // A concurrent reader may observe the exclusive reservation before its write
    // completes; it must fail closed and can query again, never execute again.
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /LOCAL_JOURNAL_UNREADABLE/);
    const retry = await new DurableLocalJournal(keys[0]!).run(request, async () => { executions++; return "bad"; });
    assert.equal(retry.record.status, "done");
    assert.equal(executions, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
