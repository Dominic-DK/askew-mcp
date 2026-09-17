#!/usr/bin/env node
import { configFromEnv, serveStdio } from "./index.js";
import { loadOrCreateKeys } from "./keys.js";

const cmd = process.argv[2];
if (cmd === "fingerprint") {
  const k = await loadOrCreateKeys(process.env.ASKEW_KEY_PATH);
  console.log(`${k.fingerprint}  (${k.path}${k.created ? ", 새로 생성" : ""})`);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`askew-mcp — Askew 로컬 커넥터(MCP stdio 서버)
  askew-mcp              MCP 서버로 실행 (Claude Code/데스크톱/Codex가 띄움)
  askew-mcp fingerprint  이 컴퓨터의 커넥터 키 지문 출력
환경변수: ASKEW_SERVER(기본 http://localhost:8787) ASKEW_CONNECTOR_KEY(akc_…) ASKEW_KEY_PATH(기본 ~/.askew/connector.key)`);
} else {
  try { await serveStdio(configFromEnv()); } catch (e: any) { process.stderr.write(`[askew-mcp] ${e?.message ?? e}\n`); process.exit(1); }
}
