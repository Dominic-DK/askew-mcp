import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AskewClient } from "./client.js";
import { loadOrCreateKeys } from "./keys.js";
import { createToolHandlers, toolSchemas, toolDescriptions, unwrapAccountKey, type ToolContext } from "./tools.js";

export { AskewClient } from "./client.js";
export { loadOrCreateKeys } from "./keys.js";
export { createToolHandlers, toolSchemas, toolDescriptions } from "./tools.js";
export * as crypto from "./crypto.js";

export const VERSION = "0.1.3";
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
  log(`[askew-mcp] connected: ${info.name} · fingerprint ${keys.fingerprint} — compare once with the fingerprint in the app's connector screen.`);
  const ctx: ToolContext = { client, keys, accountKey: null };
  ctx.accountKey = await unwrapAccountKey(ctx, info);
  log(ctx.accountKey ? "[askew-mcp] account key received — shared variables available" : "[askew-mcp] no account key yet — it arrives automatically once the phone sends it");
  return { keys, client, ctx, handlers: createToolHandlers(ctx) };
}

/**
 * stdio MCP 서버. 키가 있으면 시작 때 연결(지문 출력); 연결 실패나 키 부재여도 서버는 뜬다 —
 * 도구 목록은 항상 답하고, 도구 호출 때 다시 연결을 시도해 안 되면 isError 텍스트로 이유를 돌려준다.
 */
export async function serveStdio(cfg: ConnectorConfig) {
  const log = cfg.log ?? ((s: string) => process.stderr.write(s + "\n"));
  let booted: Awaited<ReturnType<typeof bootstrap>> | null = null;
  const ensure = async () => {
    if (booted) return booted;
    booted = await bootstrap({ ...cfg, log });
    return booted;
  };
  if (cfg.connectorKey) {
    try { await ensure(); } catch (e: any) { log(`[askew-mcp] not connected yet: ${e?.message ?? e} — will retry on the first tool call`); }
  } else {
    log(`[askew-mcp] ${NO_KEY}`);
  }
  const server = new McpServer({ name: "askew", version: VERSION });
  for (const name of Object.keys(toolSchemas) as (keyof typeof toolSchemas)[]) {
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: toolSchemas[name].shape as any }, (async (args: any) => {
      try {
        const { handlers } = await ensure();
        return await (handlers as any)[name](toolSchemas[name].parse(args ?? {}));
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `[askew-mcp] ${e?.message ?? e}` }] };
      }
    }) as any);
  }
  await server.connect(new StdioServerTransport());
}
