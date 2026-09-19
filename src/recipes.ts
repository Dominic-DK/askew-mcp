import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflow, toPlistXml, type Step } from "./compose.js";

/**
 * 에이전트가 만든 레시피를 **맥에서 조립·서명·자기검증**한다.
 *
 * 왜 자기검증이 필수인가: 틀린 매개변수 키는 오류 없이 무시된다. 실행은 성공하고 값만 빠진다.
 * 그래서 "조립됐다"는 아무 보증이 아니다 — **한 번 돌려 봐야** 안다.
 * 맥은 자동 반입이 되므로(접근성) 사람 손 없이 여기까지 갈 수 있다.
 *
 * **맥이 있어야 한다.** 서명은 macOS `shortcuts`만 하고 릴레이는 리눅스다(v1 결정, `08-v1-relaunch.md` §3).
 * 아이폰에는 자동 설치가 없으므로, 폰에 넣는 마지막 한 걸음은 **사람이 눌러야** 한다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export type ActionDef = {
  id: string; name?: string | null;
  params?: { key: string; type?: string | null; label?: string | null; in_summary?: boolean }[];
  output?: string | null; permissions?: string[]; confidence: string;
};

let catalog: ActionDef[] | null = null;
export async function actions(): Promise<ActionDef[]> {
  if (!catalog) {
    const raw = JSON.parse(await readFile(join(HERE, "..", "action-catalog.json"), "utf8"));
    catalog = raw.actions as ActionDef[];
  }
  return catalog;
}

export async function searchActions(q: string, limit = 15): Promise<ActionDef[]> {
  const n = q.toLowerCase().trim();
  if (!n) return [];
  const all = await actions();
  const score = (a: ActionDef) => {
    const id = a.id.toLowerCase(), nm = (a.name ?? "").toLowerCase();
    if (id === n) return 0;
    if (id.endsWith("." + n)) return 1;
    if (id.includes(n)) return 2;
    if (nm.includes(n)) return 3;
    if ((a.params ?? []).some(p => p.key.toLowerCase().includes(n))) return 4;
    return 99;
  };
  return all.map(a => [score(a), a] as const).filter(([s]) => s < 99)
            .sort((x, y) => x[0] - y[0]).slice(0, limit).map(([, a]) => a);
}

export function renderAction(a: ActionDef): string {
  const L = [`${a.id}${a.name ? `  — ${a.name}` : ""}  [${a.confidence}]`];
  if (a.output) L.push(`  출력: ${a.output}`);
  if (a.permissions?.length) L.push(`  권한: ${a.permissions.join(", ")}`);
  for (const p of a.params ?? []) L.push(`  · ${p.key}${p.type ? ` (${p.type})` : ""}${p.label ? ` — ${p.label}` : ""}${p.in_summary ? " *" : ""}`);
  if (!a.params?.length) L.push("  (매개변수 없음)");
  return L.join("\n");
}

/** 카탈로그에 비춰 사양을 훑는다. **막지는 않는다** — 카탈로그에 없는 동작도 있을 수 있다(앱 제공 동작). */
export async function lint(steps: Step[]): Promise<string[]> {
  const all = await actions();
  const byId = new Map(all.map(a => [a.id, a]));
  const out: string[] = [];
  for (const [i, s] of steps.entries()) {
    const a = byId.get(s.action);
    if (!a) { out.push(`${i + 1}번 "${s.action}": 카탈로그에 없는 동작이에요. 앱이 제공하는 동작이면 정상이지만, 오타가 아닌지 확인하세요.`); continue; }
    const known = new Set((a.params ?? []).map(p => p.key));
    for (const k of Object.keys(s.params ?? {})) {
      if (k === "UUID" || known.has(k)) continue;
      out.push(`${i + 1}번 "${s.action}": 매개변수 "${k}"는 이 동작에 없어요. **틀린 키는 오류 없이 무시되고 값만 빠집니다.** 쓸 수 있는 키: ${[...known].slice(0, 8).join(", ") || "(없음)"}`);
    }
  }
  return out;
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(res => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) =>
    res({ code: e ? ((e as any).code ?? 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" })));
}

const nfc = (s: string) => s.normalize("NFC");

async function installed(name: string): Promise<string | null> {
  const r = await run("/usr/bin/shortcuts", ["list", "--show-identifiers"], 15_000);
  for (const raw of r.stdout.split("\n")) {
    const line = nfc(raw).trim();
    const i = line.lastIndexOf(" (");
    if (i > 0 && line.endsWith(")") && line.slice(0, i) === nfc(name)) return line.slice(i + 2, -1);
  }
  return null;
}

export type BuildResult = {
  name: string; warnings: string[]; signedPath: string | null;
  imported: boolean; ran: boolean; output: string | null; error: string | null;
};

/**
 * 조립 → 서명 → (선택) 맥에 반입 → (선택) 실행해 보기.
 * `verify`가 참이면 **접근성 API로 "단축어 추가"를 눌러** 사람 손 없이 반입한다.
 */
export async function buildRecipe(name: string, steps: Step[], opts: { verify?: boolean; input?: string } = {}): Promise<BuildResult> {
  const res: BuildResult = { name, warnings: [], signedPath: null, imported: false, ran: false, output: null, error: null };
  if (process.platform !== "darwin") {
    res.error = "레시피 조립은 맥에서만 돼요 — 서명이 macOS 단축어 CLI에만 있어요. 이미 검증된 레시피는 그대로 쓸 수 있어요.";
    return res;
  }
  res.warnings = await lint(steps);

  const dir = await mkdtemp(join(tmpdir(), "askew-build-"));
  try {
    const wf = buildWorkflow(steps);
    const unsigned = join(dir, "u.shortcut");
    await writeFile(unsigned, toPlistXml(wf), "utf8");
    // 서명 CLI는 한글 출력 파일명을 NFD로 적는다. 파일명이 곧 단축어 이름이라
    // ASCII로 서명한 뒤 NFC 이름으로 복사해 이름 형태를 고정한다.
    const ascii = join(dir, "s.shortcut");
    const sign = await run("/usr/bin/shortcuts", ["sign", "--mode", "anyone", "--input", unsigned, "--output", ascii]);
    if (sign.code !== 0) { res.error = `서명 실패: ${sign.stderr.trim() || sign.code}`; return res; }
    const final = join(dir, nfc(name) + ".shortcut");
    await copyFile(ascii, final);
    const keep = join(tmpdir(), `askew-recipe-${Date.now()}-${nfc(name)}.shortcut`);
    await copyFile(final, keep);
    res.signedPath = keep;

    if (!opts.verify) return res;

    if (await installed(name)) { res.error = `"${name}"라는 단축어가 이미 있어요. 이름을 바꾸거나 기존 것을 지우세요.`; return res; }
    await run("/usr/bin/open", ["-g", final], 15_000);
    await new Promise(r => setTimeout(r, 1500));
    await run("/usr/bin/osascript", ["-e",
      `tell application "System Events" to tell process "Shortcuts" to click button 2 of scroll area 1 of group 1 of window 1`], 10_000);
    await new Promise(r => setTimeout(r, 1500));
    const id = await installed(name);
    if (!id) { res.error = "반입이 안 됐어요. 단축어 앱에 '단축어 추가' 창이 떠 있으면 눌러 주세요(접근성 권한이 없으면 자동으로 못 누릅니다)."; return res; }
    res.imported = true;

    const inPath = join(dir, "in.txt"), outPath = join(dir, "out.txt");
    await writeFile(inPath, opts.input ?? "", "utf8");
    const r = await run("/usr/bin/shortcuts", ["run", id, "-i", inPath, "-o", outPath], 60_000);
    if (r.code !== 0) { res.error = `실행 실패: ${r.stderr.trim() || r.code}`; return res; }
    res.ran = true;
    res.output = await readFile(outPath, "utf8").catch(() => "");
    return res;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
