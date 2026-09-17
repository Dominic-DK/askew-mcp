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

async function connect(envOverrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ASKEW_CONNECTOR_KEY" && k !== "ASKEW_SERVER") env[k] = v;
  env.ASKEW_KEY_PATH = join(mkdtempSync(join(tmpdir(), "askew-mcp-stdio-")), "connector.key");
  for (const [k, v] of Object.entries(envOverrides)) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsxCli, cliTs], env, stderr: "pipe" });
  const client = new Client({ name: "askew-mcp-test", version: "0" });
  await client.connect(transport);
  return client;
}

test("starts without ASKEW_CONNECTOR_KEY: tools/list answers, tool calls return a clear error", async () => {
  const client = await connect({});
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    for (const n of ["askew_run", "askew_notify", "askew_inbox_wait", "askew_variables_set"]) assert.ok(tools.some(t => t.name === n), n);
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
    assert.equal(tools.length, 9);
    const res: any = await client.callTool({ name: "askew_list_routes", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^\[askew-mcp\] /);
    assert.doesNotMatch(res.content[0].text, /ASKEW_CONNECTOR_KEY is not set/);
  } finally {
    await client.close();
  }
});
