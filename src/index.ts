import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AskewClient } from "./client.js";
import { loadOrCreateKeys } from "./keys.js";
import { createToolHandlers, toolSchemas, toolDescriptions, unwrapAccountKey, type ToolContext } from "./tools.js";

export { AskewClient } from "./client.js";
export { loadOrCreateKeys } from "./keys.js";
export { createToolHandlers, toolSchemas, toolDescriptions } from "./tools.js";
export * as crypto from "./crypto.js";

export type ConnectorConfig = { server: string; connectorKey: string; keyPath?: string; log?: (s: string) => void };

export function configFromEnv(): ConnectorConfig {
  const server = process.env.ASKEW_SERVER ?? "https://api.askew.my";
  const connectorKey = process.env.ASKEW_CONNECTOR_KEY ?? "";
  if (!connectorKey) throw new Error("ASKEW_CONNECTOR_KEY 환경변수가 필요합니다 (앱 → 설정 → 에이전트 연결에서 발급).");
  return { server, connectorKey, keyPath: process.env.ASKEW_KEY_PATH };
}

/** 키 준비 + 서버에 공개키 등록(첫 실행) + 도구 핸들러 */
export async function bootstrap(cfg: ConnectorConfig) {
  const log = cfg.log ?? ((s: string) => process.stderr.write(s + "\n"));
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

export async function serveStdio(cfg: ConnectorConfig) {
  const { handlers } = await bootstrap(cfg);
  const server = new McpServer({ name: "askew", version: "0.1.1" });
  for (const name of Object.keys(toolSchemas) as (keyof typeof toolSchemas)[]) {
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: toolSchemas[name].shape as any }, (async (args: any) => (handlers as any)[name](toolSchemas[name].parse(args ?? {}))) as any);
  }
  await server.connect(new StdioServerTransport());
}
