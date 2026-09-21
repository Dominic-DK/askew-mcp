import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2 * 1024 * 1024;
export type LocalCommand = (args: string[], timeoutMs: number) => Promise<{
  code: number; stdout: string; stderr: string; timedOut?: boolean;
}>;

const execute: LocalCommand = (args, timeoutMs) => new Promise(resolve => {
  execFile("/usr/bin/shortcuts", args, { timeout: timeoutMs, maxBuffer: MAX_BYTES }, (error, stdout, stderr) => {
    resolve({ code: error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "",
      timedOut: !!error?.killed || (error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT" });
  });
});

/** Resolve a route's exact display name to one installed UUID, then execute once.
 * No shell, installation, retry, remote payload, or server job is involved.
 * A timeout can occur after effects have happened; callers must not retry blindly.
 */
export function createLocalRunner(options: { platform?: string; exec?: LocalCommand } = {}) {
  return async (name: string, input: string): Promise<string> => {
    if ((options.platform ?? process.platform) !== "darwin") throw new Error("LOCAL_UNSUPPORTED: 이 실행 대상은 macOS에서만 동작해요.");
    if (Buffer.byteLength(input, "utf8") > MAX_BYTES) throw new Error("LOCAL_INPUT_TOO_LARGE: 로컬 입력이 2MB를 넘어요.");
    const run = options.exec ?? execute;
    const listing = await run(["list", "--show-identifiers"], 15_000);
    if (listing.code !== 0) throw new Error("LOCAL_LIST_FAILED: 단축어 목록을 읽지 못했어요.");
    const wanted = name.normalize("NFC");
    const ids = listing.stdout.split("\n").flatMap(raw => {
      const line = raw.normalize("NFC").trim();
      const at = line.lastIndexOf(" (");
      if (at <= 0 || !line.endsWith(")") || line.slice(0, at) !== wanted) return [];
      const id = line.slice(at + 2, -1);
      return UUID.test(id) ? [id] : [];
    });
    if (!ids.length) throw new Error(`LOCAL_NOT_FOUND: "${name}" 단축어가 이 맥에 없어요. 먼저 직접 설치하세요.`);
    if (ids.length !== 1) throw new Error(`LOCAL_AMBIGUOUS: "${name}" 단축어가 여러 개예요. 이름을 구분한 뒤 실행하세요.`);
    const dir = await mkdtemp(join(tmpdir(), "askew-local-"));
    try {
      const inputPath = join(dir, "input.txt"), outputPath = join(dir, "output.txt");
      await writeFile(inputPath, input, { encoding: "utf8", mode: 0o600 });
      const result = await run(["run", ids[0]!, "-i", inputPath, "-o", outputPath], 60_000);
      if (result.code !== 0) {
        throw new Error(`${result.timedOut ? "LOCAL_TIMEOUT" : "LOCAL_RUN_FAILED"}: 단축어 실행 결과를 확인하지 못했어요. 일부 동작은 이미 실행됐을 수 있으니 자동 재시도하지 마세요.${result.stderr.trim() ? ` ${result.stderr.trim()}` : ""}`);
      }
      let size: number;
      try { size = (await stat(outputPath)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
      if (size > MAX_BYTES) throw new Error("LOCAL_OUTPUT_TOO_LARGE: 실행은 끝났지만 출력이 2MB를 넘어요. 다시 실행하지 말고 단축어의 출력을 줄이세요.");
      return await readFile(outputPath, "utf8");
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
}

export const runLocalShortcut = createLocalRunner();
