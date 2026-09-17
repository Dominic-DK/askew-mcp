import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AskewClient } from "./client.js";
import { loadOrCreateKeys } from "./keys.js";
import { createToolHandlers, toolSchemas, toolDescriptions } from "./tools.js";

export { AskewClient } from "./client.js";
export { loadOrCreateKeys } from "./keys.js";
export { createToolHandlers, toolSchemas, toolDescriptions } from "./tools.js";
export * as crypto from "./crypto.js";

export type ConnectorConfig = { server: string; connectorKey: string; keyPath?: string; log?: (s: string) => void };

export function configFromEnv(): ConnectorConfig {
  const server = process.env.ASKEW_SERVER ?? "http://localhost:8787";
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
    log(`[askew-mcp] 공개키 등록 ${keys.created ? "(새 키 생성: " + keys.path + ")" : ""}`);
  }
  log(`[askew-mcp] 연결됨: ${info.name} · 지문 ${keys.fingerprint} — 앱의 커넥터 화면 지문과 같은지 한 번 확인하세요.`);
  return { keys, client, handlers: createToolHandlers({ client, keys }) };
}

export async function serveStdio(cfg: ConnectorConfig) {
  const { handlers } = await bootstrap(cfg);
  const server = new McpServer({ name: "askew", version: "0.1.0" });
  for (const name of Object.keys(toolSchemas) as (keyof typeof toolSchemas)[]) {
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: toolSchemas[name].shape as any }, (async (args: any) => (handlers as any)[name](toolSchemas[name].parse(args ?? {}))) as any);
  }
  await server.connect(new StdioServerTransport());
}
