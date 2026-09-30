import type { SelfInfo, CatalogRecipe, JobView } from "./client.js";
import { INSTALL_HINT } from "./guide.js";

/**
 * 세팅 점검 — 서버가 아는 것(커넥터·기기·라우트)과 공개 레시피 목록을 대조해 어긋난 곳을 짚는다.
 * 폰의 단축어 앱 안은 서버가 못 본다. 그래서 **왕복 한 번(probe)**이 디스패처·자동화·권한을 대신 확인한다.
 */
export type Finding = { level: "ok" | "warn" | "fail"; text: string };

const STALE_DAYS = 7;
/** 점검 왕복에 써도 되는 라우트 — 읽기만 하고 아무것도 바꾸지 않는 것만. 입력은 라우트 계약에 맞춘 고정값. */
export const PROBE_ROUTES: Record<string, string> = { "device.status": "{}", "echo": "askew setup check" };

/** 에이전트에게 보여줄 레시피만 — 사람에게 되묻는 solo 판과 디스패처는 뺀다. */
export function agentRecipes(catalog: CatalogRecipe[]) {
  return catalog.filter(r => r.kind === "route" && r.route && r.audience !== "solo");
}

export function diagnose(info: SelfInfo, catalog: CatalogRecipe[] | null, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  const ok = (text: string) => out.push({ level: "ok", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  const fail = (text: string) => out.push({ level: "fail", text });

  if (info.stopped) fail("Account is in emergency stop — nothing will run. The user turns it off in the Askew app.");
  if (info.mode !== "e2e") fail("Connector has not uploaded its public key (mode=server). Restart this connector once.");
  else ok(`Connector "${info.name}" is connected end-to-end.`);
  if (!info.verified) warn(`Fingerprint not verified. Ask the user to open Askew › Settings › Connector and tap "Words match · Verified" if the words are: ${info.fingerprintWords?.join(" ") ?? info.fingerprint ?? "(unknown)"}.`);
  if (!info.accountKey) warn("No account key from the phone yet — shared variables are unavailable until the user taps \"Resend account key\" in Askew › Settings › Connector.");

  if (!info.devices.length) fail("No phone/iPad is registered. The user opens the Askew app and allows notifications.");
  for (const d of info.devices) {
    const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
    if (!Number.isFinite(seen)) warn(`Device "${d.name ?? d.deviceId}" has never checked in. Ask the user to open the Askew app on it.`);
    else if (now - seen > STALE_DAYS * 86400_000) warn(`Device "${d.name ?? d.deviceId}" last checked in ${Math.floor((now - seen) / 86400_000)} days ago — it may be off, signed out, or Askew was deleted.`);
    else ok(`Device "${d.name ?? d.deviceId}" checked in ${d.lastSeenAt}.`);
  }

  if (!info.routes.length) fail(`No routes installed. ${INSTALL_HINT} Install "askew-dispatcher" first, then the recipes the user wants.`);
  const byRoute = new Map((catalog ? agentRecipes(catalog) : []).map(r => [r.route!, r]));
  const names = new Map<string, string[]>();
  for (const r of info.routes) {
    const key = r.shortcutName.normalize("NFC");
    names.set(key, [...(names.get(key) ?? []), r.name]);
    const recipe = byRoute.get(r.name);
    if (recipe && recipe.shortcutName.normalize("NFC") !== key) {
      fail(`Route ${r.name} calls Shortcut "${r.shortcutName}" but the current recipe installs "${recipe.shortcutName}". Ask the user to delete the old Shortcut and this route (Askew › My Shortcuts), then reinstall "${recipe.name}". ${INSTALL_HINT}`);
      continue;
    }
    if (!/^[\x20-\x7e]+$/.test(r.shortcutName)) warn(`Route ${r.name} calls a non-ASCII Shortcut name "${r.shortcutName}". Such names can differ in Unicode form between the app and Shortcuts and then silently fail to match; an ASCII name is safer.`);
    if (!r.enabled) warn(`Route ${r.name} is turned off in the app.`);
    else if (!r.lastSuccessAt) warn(`Route ${r.name} has never succeeded. Run it once with the phone unlocked so the user can tap "Always Allow" if asked.`);
    if (!r.inputExample && !r.inputHint) warn(`Route ${r.name} declares no input contract — ask the user what its Shortcut expects before running it.`);
  }
  for (const [name, routes] of names) if (routes.length > 1) warn(`Routes ${routes.join(", ")} all call Shortcut "${name}". Check that this is intended.`);
  if (info.routes.length && !out.some(f => f.level !== "ok" && f.text.startsWith("Route "))) ok(`${info.routes.length} route(s) match the current recipes.`);
  if (catalog === null) warn("Could not load the recipe catalog, so routes were not compared with current recipes.");
  out.push({ level: "ok", text: "The dispatcher and its automation live only in the phone's Shortcuts app; the relay cannot see them. A probe run checks them." });
  return out;
}

/** 점검 왕복의 결과를 사람 말로 — 어디서 멈췄는지가 원인을 가른다(가이드의 SYMPTOM 표와 같은 판정). */
export function interpretProbe(job: JobView): Finding {
  const steps = new Set(job.timeline.map(t => t.step));
  const started = steps.has("started");
  if (job.status === "done") return { level: "ok", text: `Probe round trip OK (${job.timeline.map(t => `${t.step}@${t.at.slice(11, 19)}`).join(" → ")}). Dispatcher, automation and permissions work.` };
  if (job.status === "failed") return { level: "fail", text: `Probe reached the Shortcut but it failed: ${job.error ?? "(no error text)"}.` };
  if (!started && (job.status === "expired" || job.status === "pushed" || job.status === "queued"))
    return { level: "fail", text: `Probe was ${job.status === "queued" ? "not pushed" : "pushed"} but the phone never started it. Check on the phone: "askew-dispatcher" exists, its automation is ON, Askew notifications are allowed and no Focus blocks them. Then run askew_setup_check again.` };
  if (started) return { level: "fail", text: `The dispatcher started but no result came back (status ${job.status}). Most likely the target Shortcut is missing or renamed, or a permission prompt ("Always Allow") is waiting on the phone. Ask the user to unlock the phone and look. Do not re-run automatically; use askew_get_run with jobId ${job.jobId}.` };
  return { level: "warn", text: `Probe status ${job.status} — not finished yet. Check later with askew_get_run jobId ${job.jobId}.` };
}

export function renderFindings(findings: Finding[]): string {
  const mark = { ok: "OK  ", warn: "WARN", fail: "FAIL" } as const;
  const fails = findings.filter(f => f.level === "fail").length, warns = findings.filter(f => f.level === "warn").length;
  return [`Setup check: ${fails} problem(s), ${warns} warning(s).`, ...findings.map(f => `${mark[f.level]} ${f.text}`)].join("\n");
}

export function renderCatalog(catalog: CatalogRecipe[], info: SelfInfo | null, query?: string): string {
  const installed = new Map((info?.routes ?? []).map(r => [r.name, r]));
  const q = query?.trim().toLowerCase();
  const list = agentRecipes(catalog).filter(r => !q || [r.id, r.name, r.oneLine, r.app].some(v => v?.toLowerCase().includes(q)));
  if (!list.length) return q ? `No recipe matches "${query}". Consider askew_recipe_build on a Mac.` : "The recipe catalog is empty.";
  const lines = [`${list.length} recipe(s). ${info ? "installed=yes means a route exists for it on this account." : "Install state unknown (connector not connected)."}`];
  for (const r of list) {
    const route = installed.get(r.route!);
    const state = !info ? "" : !route ? " installed=no" : route.shortcutName.normalize("NFC") === r.shortcutName.normalize("NFC") ? " installed=yes" : ` installed=OUTDATED (route calls "${route.shortcutName}")`;
    lines.push(`recipe: ${r.route} "${r.name}" shortcut="${r.shortcutName}"${state}${r.verified ? "" : " (not yet verified on a phone)"}`);
    if (r.oneLine) lines.push(`  what: ${r.oneLine}`);
    if (r.input !== undefined && r.input !== null) lines.push(`  input: ${JSON.stringify(r.input)}`);
    if (r.output) lines.push(`  output: ${r.output}`);
    if (r.ipad && r.ipad.support !== "yes") lines.push(`  iPad: ${r.ipad.support}${r.ipad.note ? ` — ${r.ipad.note}` : ""}`);
  }
  lines.push(INSTALL_HINT);
  return lines.join("\n");
}
