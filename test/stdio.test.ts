import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxCli = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const cliTs = join(here, "..", "src", "cli.ts");

async function connect(envOverrides: Record<string, string | undefined>, entry = cliTs) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ASKEW_CONNECTOR_KEY" && k !== "ASKEW_SERVER") env[k] = v;
  env.ASKEW_KEY_PATH = join(mkdtempSync(join(tmpdir(), "askew-mcp-stdio-")), "connector.key");
  for (const [k, v] of Object.entries(envOverrides)) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsxCli, entry], env, stderr: "pipe" });
  const client = new Client({ name: "askew-mcp-test", version: "0" });
  await client.connect(transport);
  return client;
}

test("starts without ASKEW_CONNECTOR_KEY: tools/list answers, tool calls return a clear error", async () => {
  const client = await connect({});
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    for (const n of ["askew_run", "askew_notify", "askew_inbox_wait", "askew_variables_set"]) assert.ok(tools.some(t => t.name === n), n);
    // 카탈로그 검색과 레시피 조립은 이 컴퓨터 안에서만 끝난다 — 키가 없어도 **실제로 동작해야** 한다.
    const cat: any = await client.callTool({ name: "askew_actions_search", arguments: { query: "getbatterylevel" } });
    assert.notEqual(cat.isError, true, "카탈로그 검색은 키 없이도 돼야 한다");
    assert.match(cat.content[0].text, /WFTextTokenString|Subject|getbatterylevel/);
    const res: any = await client.callTool({ name: "askew_list_routes", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ASKEW_CONNECTOR_KEY/);
  } finally {
    await client.close();
  }
});

test("starts when the relay is unreachable: tools/list answers, tool calls report the connection error", async () => {
  const client = await connect({ ASKEW_CONNECTOR_KEY: "akc_test", ASKEW_SERVER: "http://127.0.0.1:1" });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    const res: any = await client.callTool({ name: "askew_list_routes", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^\[askew-mcp\] /);
    assert.doesNotMatch(res.content[0].text, /ASKEW_CONNECTOR_KEY is not set/);
  } finally {
    await client.close();
  }
});

test("recipe stdio builds stay local; upload bootstraps on demand and excludes run output", async () => {
  const { createServer } = await import("node:http");
  const calls: string[] = [];
  let uploaded: any;
  const relay = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/connectors/self") {
      res.end(JSON.stringify({ name: "test", fingerprint: null, accountKey: null }));
    } else if (req.url === "/v1/connectors/self/key") {
      res.end(JSON.stringify({ fingerprint: "test" }));
    } else if (req.url === "/v1/recipes/agent") {
      uploaded = body;
      if (body.name === "fail-upload") {
        res.statusCode = 422; res.end(JSON.stringify({ error: { code: "UNSUPPORTED_FILE", message: "test rejected" } }));
      } else {
        res.statusCode = 201; res.end(JSON.stringify({ recipe: { id: "test-recipe" } }));
      }
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(r => relay.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(relay.address() as any).port}`;
  const client = await connect({ ASKEW_CONNECTOR_KEY: "akc_test", ASKEW_SERVER: base }, join(here, "fixtures", "recipe-stdio.ts"));
  const args = { name: "local", steps: [{ action: "is.workflow.actions.getbatterylevel" }], verify: false };
  try {
    assert.deepEqual(calls, [], "stdio startup must not contact relay");
    const local: any = await client.callTool({ name: "askew_recipe_build", arguments: args });
    assert.notEqual(local.isError, true);
    assert.deepEqual(calls, [], "local build must not contact relay, even with key configured");
    const upload: any = await client.callTool({ name: "askew_recipe_build", arguments: { ...args, sendToPhone: true } });
    assert.notEqual(upload.isError, true, JSON.stringify(upload));
    assert.deepEqual(calls, ["GET /v1/connectors/self", "POST /v1/connectors/self/key", "POST /v1/recipes/agent"]);
    assert.deepEqual(Object.keys(uploaded).sort(), ["file", "name", "workflow"]);
    assert.doesNotMatch(JSON.stringify(uploaded), /PRIVATE_CALENDAR_OUTPUT_NEVER_UPLOAD|verifiedRun/);
    const rejected: any = await client.callTool({ name: "askew_recipe_build", arguments: { ...args, name: "fail-upload", sendToPhone: true } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /test rejected/);
    const before = calls.length;
    const failed: any = await client.callTool({ name: "askew_recipe_build", arguments: { ...args, name: "fail-build", sendToPhone: true } });
    assert.equal(failed.isError, true);
    assert.equal(calls.length, before, "failed builds must not upload");
  } finally {
    await client.close();
    await new Promise<void>(resolve => relay.close(() => resolve()));
  }
});

test("recipe stdio upload without a key reports isError after local build", async () => {
  const client = await connect({}, join(here, "fixtures", "recipe-stdio.ts"));
  try {
    const result: any = await client.callTool({ name: "askew_recipe_build", arguments: {
      name: "no-key", steps: [{ action: "is.workflow.actions.getbatterylevel" }], verify: false, sendToPhone: true,
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ASKEW_CONNECTOR_KEY/);
    assert.doesNotMatch(result.content[0].text, /Cannot read properties of null/);
  } finally { await client.close(); }
});
