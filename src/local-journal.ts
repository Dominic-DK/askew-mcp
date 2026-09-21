import { createHash, randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnvelope, open, seal } from "./crypto.js";
import type { ConnectorKeys } from "./keys.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ID = /^local_[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Stable object ordering; string inputs remain byte-sensitive. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("LOCAL_INPUT_INVALID: JSON 입력이 필요해요.");
  return encoded;
}

export type LocalRunRecord = {
  v: 1; scope: string; jobId: string; requestHash: string; routeId: string;
  status: "done" | "unknown"; startedAt: string; finishedAt?: string; output?: string; error?: string;
};
export type LocalRunRequest = { connectorId: string; routeId: string; shortcutName: string; input: unknown; idempotencyKey?: string };
export type LocalJournal = Pick<DurableLocalJournal, "run" | "get">;

async function syncDirectory(path: string) {
  const fd = await openFile(path, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}

/** A reservation is durably written BEFORE dispatch. An interrupted/uncertain run
 * stays unknown forever and is never dispatched again with the same key.
 * Records (including result, request digest and route metadata) are HPKE sealed
 * to this connector, and are never uploaded. Deleting them loses deduplication.
 */
export class DurableLocalJournal {
  constructor(private keys: ConnectorKeys, private root = join(dirname(keys.path), "local-runs")) {}

  private scope(connectorId: string) { return digest(JSON.stringify([connectorId, this.keys.publicKeyB64])); }
  private directory(connectorId: string) { return join(this.root, this.scope(connectorId)); }

  async get(connectorId: string, jobId: string): Promise<LocalRunRecord> {
    if (!ID.test(jobId)) throw new Error("LOCAL_RUN_ID_INVALID: 잘못된 로컬 실행 ID예요.");
    let value: LocalRunRecord;
    try {
      const envelope: unknown = JSON.parse(await readFile(join(this.directory(connectorId), `${jobId}.json`), "utf8"));
      if (!isEnvelope(envelope)) throw new Error("Invalid envelope");
      value = JSON.parse(await open(this.keys.privateKey, "localrun", envelope));
      if (value.v !== 1 || value.scope !== this.scope(connectorId) || value.jobId !== jobId ||
          !/^[a-f0-9]{64}$/.test(value.requestHash) || typeof value.routeId !== "string" ||
          typeof value.startedAt !== "string" || !["done", "unknown"].includes(value.status) ||
          (value.status === "done" && typeof value.output !== "string")) throw new Error("Invalid record");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`LOCAL_RUN_NOT_FOUND: ${jobId} 기록이 이 커넥터에 없어요.`);
      throw new Error(`LOCAL_JOURNAL_UNREADABLE: ${jobId} 기록을 검증할 수 없어 재실행하지 않았어요. 이전 실행의 효과를 직접 확인하세요.`);
    }
    return value;
  }

  private async write(path: string, record: LocalRunRecord) {
    const envelope = await seal(this.keys.publicKeyB64, "localrun", JSON.stringify(record));
    const fd = await openFile(path, "wx", 0o600);
    try { await fd.writeFile(JSON.stringify(envelope)); await fd.sync(); } finally { await fd.close(); }
  }

  async run(request: LocalRunRequest, execute: () => Promise<string>): Promise<{ record: LocalRunRecord; replayed: boolean }> {
    if (request.idempotencyKey !== undefined && (request.idempotencyKey.length === 0 || request.idempotencyKey.length > 200)) {
      throw new Error("LOCAL_IDEMPOTENCY_INVALID: idempotencyKey는 1–200자여야 해요.");
    }
    const scope = this.scope(request.connectorId);
    const jobId = `local_${digest(JSON.stringify([scope, request.idempotencyKey === undefined ? "unkeyed" : "keyed", request.idempotencyKey ?? randomUUID()]))}`;
    const requestHash = digest(canonicalJSON({ routeId: request.routeId, shortcutName: request.shortcutName, input: request.input }));
    const directory = this.directory(request.connectorId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Persist both new directory entries before a run can have external effects.
    await syncDirectory(dirname(this.root));
    await syncDirectory(this.root);
    const path = join(directory, `${jobId}.json`);
    const initial: LocalRunRecord = { v: 1, scope, jobId, requestHash, routeId: request.routeId,
      status: "unknown", startedAt: new Date().toISOString() };
    try { await this.write(path, initial); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.get(request.connectorId, jobId);
      if (existing.requestHash !== requestHash) throw new Error(`LOCAL_IDEMPOTENCY_CONFLICT: ${jobId}에 이미 다른 입력 또는 단축어가 기록되어 있어 실행하지 않았어요.`);
      return { record: existing, replayed: true };
    }
    await syncDirectory(directory);
    let record: LocalRunRecord;
    try {
      const output = await execute();
      if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new Error("LOCAL_OUTPUT_TOO_LARGE: 실행 출력이 2MB를 넘어요. 다시 실행하지 마세요.");
      record = { ...initial, status: "done", output, finishedAt: new Date().toISOString() };
    } catch (error) {
      record = { ...initial, error: String(error instanceof Error ? error.message : error).slice(0, 8_192), finishedAt: new Date().toISOString() };
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await this.write(temporary, record);
      await rename(temporary, path);
      await syncDirectory(directory);
    } catch {
      // Never report success without a durable result. The reserved key is kept.
      return { record: { ...initial, error: "LOCAL_JOURNAL_WRITE_FAILED: 실행 후 결과를 보존하지 못했어요. 재실행하지 말고 효과를 직접 확인하세요." }, replayed: false };
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    return { record, replayed: false };
  }
}
