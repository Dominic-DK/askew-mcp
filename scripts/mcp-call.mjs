// 개발용 MCP 드라이버: askew-mcp를 stdio로 띄워 도구 하나를 호출하고 결과를 찍는다.
// 사용: ASKEW_CONNECTOR_KEY=akc_… node scripts/mcp-call.mjs askew_notify '{"title":"연결됐어요","body":"Askew 첫 인사"}'
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const [tool, argJson = "{}"] = process.argv.slice(2);
if (!tool) { console.error("도구 이름이 필요해요"); process.exit(1); }
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const p = spawn("node", [cli], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
let buf = ""; let id = 0; const pending = new Map();
p.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n"); });
await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dev", version: "0" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const r = await send("tools/call", { name: tool, arguments: JSON.parse(argJson) });
console.log(JSON.stringify(r.result ?? r.error, null, 2));
p.kill();
