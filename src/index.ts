import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AskewClient } from "./client.js";
import { loadOrCreateKeys } from "./keys.js";
import { createToolHandlers, toolSchemas, toolDescriptions, unwrapAccountKey, type ToolContext, type ToolDependencies } from "./tools.js";
import { AGENT_GUIDE } from "./guide.js";

export { AskewClient } from "./client.js";
export { loadOrCreateKeys } from "./keys.js";
export { createToolHandlers, toolSchemas, toolDescriptions } from "./tools.js";
export { AGENT_GUIDE } from "./guide.js";
export * as crypto from "./crypto.js";

export const VERSION = "0.3.0";
export const NO_KEY = "ASKEW_CONNECTOR_KEY is not set. Get a key in the Askew app (Settings → New connector) and start the connector with ASKEW_CONNECTOR_KEY=akc_… — https://askew.my/#setup";

export type ConnectorConfig = { server: string; connectorKey: string; keyPath?: string; log?: (s: string) => void };

/** 환경변수 → 설정. 키가 없어도 던지지 않는다: 서버는 뜨고, 도구 호출이 NO_KEY 오류를 돌려준다(디렉터리 헬스체크·tools/list 호환). */
export function configFromEnv(): ConnectorConfig {
  const server = process.env.ASKEW_SERVER ?? "https://api.askew.my";
  const connectorKey = process.env.ASKEW_CONNECTOR_KEY ?? "";
  return { server, connectorKey, keyPath: process.env.ASKEW_KEY_PATH };
}

/** 키 준비 + 서버에 공개키 등록(첫 실행) + 도구 핸들러 */
export async function bootstrap(cfg: ConnectorConfig) {
  const log = cfg.log ?? ((s: string) => process.stderr.write(s + "\n"));
  if (!cfg.connectorKey) throw new Error(NO_KEY);
  const keys = await loadOrCreateKeys(cfg.keyPath);
  const client = new AskewClient(cfg.server, cfg.connectorKey);
  const info = await client.self();
  if (!info.fingerprint || info.fingerprint !== keys.fingerprint) {
    await client.registerKey(keys.publicKeyB64);
    log(`[askew-mcp] public key registered${keys.created ? " (new key: " + keys.path + ")" : ""}`);
  }
  log(`[askew-mcp] connected: ${info.name}`);
  // 지문은 사람이 눈으로 맞춰 보라고 있는 것이다. 16진수는 한 글자 틀려도 티가 안 나므로 단어를 같이 낸다.
  log(`[askew-mcp] fingerprint: ${keys.words.join(" ")}   (${keys.fingerprint})`);
  log(`[askew-mcp] 폰의 Askew 앱 › 설정 › 커넥터에서 같은 단어 6개가 보이면 "확인함"을 누르세요.`);
  const ctx: ToolContext = { client, keys, accountKey: null };
  ctx.accountKey = await unwrapAccountKey(ctx, info);
  log(ctx.accountKey ? "[askew-mcp] account key received — shared variables available" : "[askew-mcp] no account key yet — it arrives automatically once the phone sends it");
  return { keys, client, ctx, handlers: createToolHandlers(ctx) };
}

/**
 * stdio MCP 서버. 인증이 필요한 도구를 호출하거나 완성된 레시피를 업로드할 때만 연결한다.
 * 로컬 조립과 tools/list는 키·릴레이 연결 없이 동작한다.
 */
export async function serveStdio(cfg: ConnectorConfig, dependencies: Pick<ToolDependencies, "buildRecipe"> = {}) {
  const log = cfg.log ?? ((s: string) => process.stderr.write(s + "\n"));
  let booted: Awaited<ReturnType<typeof bootstrap>> | null = null;
  let booting: Promise<Awaited<ReturnType<typeof bootstrap>>> | null = null;
  const ensure = async () => {
    if (booted) return booted;
    // One initial connection/key registration even when MCP calls arrive together.
    booting ??= bootstrap({ ...cfg, log }).then(value => booted = value).finally(() => { booting = null; });
    return booting;
  };
  // 안내문은 연결 때 한 번 간다 — 세팅 순서와 증상별 원인을 에이전트가 처음부터 알게.
  const server = new McpServer({ name: "askew", version: VERSION }, { instructions: AGENT_GUIDE });
  // 카탈로그 검색과 레시피 조립은 **이 컴퓨터 안에서만** 끝난다. 서버도 키도 필요 없다.
  // 연결을 기다리게 하면 키가 없는 사람이 카탈로그도 못 보게 된다. 레시피 목록도 공개라 키 없이 연다.
  const LOCAL: ReadonlySet<string> = new Set(["askew_actions_search", "askew_recipe_build", "askew_recipes_catalog"]);
  const publicClient = new AskewClient(cfg.server, "");
  for (const name of Object.keys(toolSchemas) as (keyof typeof toolSchemas)[]) {
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: toolSchemas[name].shape as any }, (async (args: any) => {
      try {
        const handlers = LOCAL.has(name) ? createToolHandlers({ client: null as any, keys: null as any, accountKey: null }, {
            ...dependencies, recipeClient: async () => (await ensure()).client,
            catalog: () => publicClient.recipes(), selfInfo: async () => (await ensure()).client.self(),
          })
                                         : (await ensure()).handlers;
        return await (handlers as any)[name](toolSchemas[name].parse(args ?? {}));
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `[askew-mcp] ${e?.message ?? e}` }] };
      }
    }) as any);
  }
  await server.connect(new StdioServerTransport());
}
