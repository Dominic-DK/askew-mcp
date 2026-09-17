#!/usr/bin/env node
import { configFromEnv, serveStdio } from "./index.js";
import { loadOrCreateKeys } from "./keys.js";

const cmd = process.argv[2];
if (cmd === "fingerprint") {
  const k = await loadOrCreateKeys(process.env.ASKEW_KEY_PATH);
  console.log(`${k.fingerprint}  (${k.path}${k.created ? ", newly created" : ""})`);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`askew-mcp — Askew local connector (MCP server over stdio). https://askew.my
  askew-mcp              run as an MCP server (Claude Code / Claude Desktop / Cursor / Codex launch this)
  askew-mcp fingerprint  print this computer's connector key fingerprint
Environment: ASKEW_CONNECTOR_KEY=akc_… (required)  ASKEW_SERVER (default https://api.askew.my)  ASKEW_KEY_PATH (default ~/.askew/connector.key)`);
} else {
  try { await serveStdio(configFromEnv()); } catch (e: any) { process.stderr.write(`[askew-mcp] ${e?.message ?? e}\n`); process.exit(1); }
}
