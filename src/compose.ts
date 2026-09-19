import { randomUUID } from "node:crypto";

/**
 * 단축어 조립기 — 에이전트가 준 사양을 단축어 plist로 만든다.
 *
 * 파이썬 원본(`tools/shortcut-gen/compose.py`)의 토큰 구조를 그대로 옮겼다. 그 구조는
 * 폰에서 **수확한 실제 단축어**에서 나온 것이라 추측이 아니다.
 *
 * 핵심 함정: **틀린 매개변수 키는 오류를 내지 않고 조용히 무시된다.**
 * 그래서 값이 안 들어간 채로 실행되고, 확신에 찬 틀린 답이 나온다(2026-09-19 반증 시험).
 * 카탈로그(`action-catalog.json`)로 키를 검사하고, 조립한 것은 **반드시 실행해 봐야** 한다.
 */

const OBJ = "￼";                       // 토큰이 들어갈 자리를 차지하는 글자
const uuid = () => randomUUID().toUpperCase();

export type Tok =
  | string
  | { kind: "input"; key: string }          // 단축어 입력(JSON) → 사전 → key
  | { kind: "ref"; of: string; name: string; prop?: string };  // 앞선 동작의 출력

function piece(t: Exclude<Tok, string>, ids: Map<string, string>): unknown {
  if (t.kind === "input") {
    return { Type: "ExtensionInput", Aggrandizements: [
      { Type: "WFCoercionVariableAggrandizement", CoercionItemClass: "WFDictionaryContentItem" },
      { Type: "WFDictionaryValueVariableAggrandizement", DictionaryKey: t.key }] };
  }
  const real = ids.get(t.of);
  if (!real) throw new Error(`앞선 동작 "${t.of}"를 찾을 수 없어요. step의 id를 확인하세요.`);
  const a: Record<string, unknown> = { OutputUUID: real, Type: "ActionOutput", OutputName: t.name };
  if (t.prop) a.Aggrandizements = [{ Type: "WFPropertyVariableAggrandizement", PropertyName: t.prop }];
  return a;
}

/** 글자와 토큰을 섞은 텍스트 칸. */
export function tok(parts: Tok[], ids: Map<string, string>): unknown {
  let s = ""; const att: Record<string, unknown> = {};
  for (const p of parts) {
    if (typeof p === "string") { s += p; continue; }
    att[`{${s.length}, 1}`] = piece(p, ids); s += OBJ;
  }
  const v: Record<string, unknown> = { string: s };
  if (Object.keys(att).length) v.attachmentsByRange = att;
  return { Value: v, WFSerializationType: "WFTextTokenString" };
}

/** 변수 하나만 들어가는 칸(WFInput 등). 텍스트 칸과 인코딩이 다르다 — 섞으면 값이 안 들어간다. */
export function attach(t: Exclude<Tok, string>, ids: Map<string, string>): unknown {
  return { Value: piece(t, ids), WFSerializationType: "WFTextTokenAttachment" };
}

/** 에이전트가 주는 한 단계. */
export type Step = {
  /** 이 단계를 뒤에서 가리킬 이름. `{"ref": {...}}`의 `of`가 이걸 쓴다. */
  id?: string;
  /** 동작 식별자. 카탈로그에 있는 값이어야 한다. */
  action: string;
  /** 매개변수. 값은 그대로 두거나 `{text:[...]}`·`{attach:{...}}`로 감싼다. */
  params?: Record<string, unknown>;
};

function resolve(v: unknown, ids: Map<string, string>): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.text)) return tok(o.text as Tok[], ids);
    if (o.attach) return attach(o.attach as Exclude<Tok, string>, ids);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = resolve(x, ids);
    return out;
  }
  if (Array.isArray(v)) return v.map(x => resolve(x, ids));
  return v;
}

/** 단축어 plist(사전)를 만든다. 서명은 하지 않는다 — 그건 macOS `shortcuts sign`의 일이다. */
export function buildWorkflow(steps: Step[]): Record<string, unknown> {
  if (!steps.length) throw new Error("동작이 하나도 없어요.");
  const ids = new Map<string, string>();
  for (const s of steps) if (s.id) ids.set(s.id, uuid());

  const actions = steps.map(s => {
    const p: Record<string, unknown> = { UUID: s.id ? ids.get(s.id)! : uuid() };
    for (const [k, v] of Object.entries(s.params ?? {})) p[k] = resolve(v, ids);
    return { WFWorkflowActionIdentifier: s.action, WFWorkflowActionParameters: p };
  });

  return {
    WFWorkflowClientVersion: "3000.1.1",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 61440 },
    WFWorkflowImportQuestions: [],
    WFWorkflowTypes: ["NCWidget", "WatchKit"],
    WFWorkflowInputContentItemClasses: ["WFStringContentItem", "WFDictionaryContentItem"],
    WFWorkflowActions: actions,
  };
}

/**
 * XML plist 직렬화 — 의존성 없이. macOS `shortcuts sign`이 XML을 그대로 받는다(2026-09-20 확인:
 * XML 5,080B·바이너리 1,918B 둘 다 서명 성공). **XML을 쓰는 이유는 사람이 읽을 수 있어서다** —
 * 에이전트가 만든 것을 사용자가 열어 볼 수 있어야 한다.
 */
export function toPlistXml(v: unknown): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const node = (x: unknown, ind: string): string => {
    if (x === null || x === undefined) return `${ind}<string></string>`;
    if (typeof x === "boolean") return `${ind}<${x}/>`;
    if (typeof x === "number") {
      return Number.isInteger(x) ? `${ind}<integer>${x}</integer>` : `${ind}<real>${x}</real>`;
    }
    if (typeof x === "string") return `${ind}<string>${esc(x)}</string>`;
    if (x instanceof Uint8Array) return `${ind}<data>${Buffer.from(x).toString("base64")}</data>`;
    if (Array.isArray(x)) {
      if (!x.length) return `${ind}<array/>`;
      return `${ind}<array>\n${x.map(i => node(i, ind + "  ")).join("\n")}\n${ind}</array>`;
    }
    const e = Object.entries(x as Record<string, unknown>);
    if (!e.length) return `${ind}<dict/>`;
    const body = e.map(([k, val]) => `${ind}  <key>${esc(k)}</key>\n${node(val, ind + "  ")}`).join("\n");
    return `${ind}<dict>\n${body}\n${ind}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n${node(v, "")}\n</plist>\n`;
}
