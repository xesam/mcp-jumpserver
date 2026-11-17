import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, MCP_JUMPSERVER_CONFIG: "mcp-jumpserver.example.yaml" },
});
const client = new Client({ name: "smoke-test", version: "0.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  assert.deepEqual(toolNames, [
    "connect",
    "send_input",
    "confirm_shell",
    "execute",
    "cancel",
    "get_session",
    "list_sessions",
    "close",
  ]);

  const listed = await client.callTool({ name: "list_sessions", arguments: {} });
  assert.equal(listed.isError, undefined);
  assert.deepEqual(JSON.parse(listed.content[0].text), { sessions: [] });

  const notFound = await client.callTool({ name: "get_session", arguments: { session_id: "sess_missing" } });
  assert.equal(notFound.isError, true);
  assert.equal(JSON.parse(notFound.content[0].text).error, "session_not_found");

  const disallowed = await client.callTool({ name: "connect", arguments: { asset: "prod-db" } });
  assert.equal(disallowed.isError, true);
  assert.equal(JSON.parse(disallowed.content[0].text).error, "asset_not_allowed");

  const listed2 = await client.callTool({ name: "list_sessions", arguments: {} });
  assert.deepEqual(JSON.parse(listed2.content[0].text), { sessions: [] });

  console.log("SMOKE OK");
} catch (err) {
  console.error("SMOKE FAILED:", err);
  process.exitCode = 1;
} finally {
  await client.close();
}
