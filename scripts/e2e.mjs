import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Required: MCP_JUMPSERVER_CONFIG, JUMPSERVER_MCP_TEST_ASSET.
// Optional: JUMPSERVER_MCP_TEST_LOGIN_INPUTS - a comma-separated list of further inputs sent via
//   send_input after the asset name (e.g. a list index, then an account index), for assets whose
//   login needs more than one step before the target host's shell appears.
const results = [];
const configPath = process.env.MCP_JUMPSERVER_CONFIG;
const testAsset = process.env.JUMPSERVER_MCP_TEST_ASSET;
const loginInputs = (process.env.JUMPSERVER_MCP_TEST_LOGIN_INPUTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

if (!configPath || !testAsset) {
  console.error(
    "E2E requires MCP_JUMPSERVER_CONFIG and JUMPSERVER_MCP_TEST_ASSET " +
      "(optionally JUMPSERVER_MCP_TEST_LOGIN_INPUTS, a comma-separated list of further send_input values)",
  );
  process.exit(2);
}

function check(name, cond, extra) {
  results.push({ name, pass: cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  <<< " + JSON.stringify(extra)}`);
}

function textOf(result) {
  return result.content?.[0]?.text ?? "";
}
function jsonOf(result) {
  try {
    return JSON.parse(textOf(result));
  } catch {
    return {};
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, MCP_JUMPSERVER_CONFIG: configPath },
});
const client = new Client({ name: "e2e-test", version: "0.0.0" });
await client.connect(transport);

async function failFast() {
  const failed = results.filter((r) => !r.pass);
  console.log(`E2E FAILED: ${failed.length}/${results.length}`);
  await client.close();
  process.exit(1);
}

// Drives the login interaction for a freshly connected or reused-interactive session: sends the
// asset name, then any further inputs from JUMPSERVER_MCP_TEST_LOGIN_INPUTS (e.g. a list index or
// account index), then calls confirm_shell. Exits the process on login failure.
async function login(sessionId) {
  await client.callTool({ name: "send_input", arguments: { session_id: sessionId, input: testAsset } });
  for (const input of loginInputs) {
    await client.callTool({ name: "send_input", arguments: { session_id: sessionId, input } });
  }
  const confirmed = await client.callTool({ name: "confirm_shell", arguments: { session_id: sessionId } });
  const confirmedJson = jsonOf(confirmed);
  check("confirm_shell ready", !confirmed.isError && confirmedJson.ready === true, confirmedJson);
  if (!confirmedJson.ready) {
    console.log(`confirm_shell output: ${confirmedJson.output ?? ""}`);
    await failFast();
  }
  check("confirm_shell has no host warning", confirmedJson.warning === undefined, confirmedJson);
  if (confirmedJson.warning !== undefined) {
    console.log(`confirm_shell warning: ${confirmedJson.warning}`);
  }
  return confirmedJson;
}

const c = await client.callTool({ name: "connect", arguments: { asset: testAsset } });
const cj = jsonOf(c);
check(`connect ${testAsset}`, !c.isError && typeof cj.session_id === "string", cj);
const sid = cj.session_id;
if (!sid) {
  await failFast();
}
check("connect returns interactive with output", cj.status === "interactive" && typeof cj.output === "string", cj);

const reused = await client.callTool({ name: "connect", arguments: { asset: testAsset } });
const reusedJson = jsonOf(reused);
check(
  "connect same asset reuses existing session",
  !reused.isError && reusedJson.session_id === sid && reusedJson.reused === true,
  reusedJson,
);

await login(sid);

const wide = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "echo " + "x".repeat(300) } });
check("300-column echo is parsed", jsonOf(wide).stdout === "x".repeat(300), jsonOf(wide));

const r1 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "pwd" } });
const initialPwd = jsonOf(r1).stdout;
check(
  "pwd returns an absolute path",
  jsonOf(r1).exit_code === 0 && typeof initialPwd === "string" && initialPwd.startsWith("/"),
  jsonOf(r1),
);

const r2 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "cd /tmp" } });
check("cd /tmp exit=0", jsonOf(r2).exit_code === 0, jsonOf(r2));

const r3 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "pwd" } });
check("pwd => /tmp (shell state kept)", jsonOf(r3).stdout === "/tmp", jsonOf(r3));

const r4 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "export E2E_VAR=hello" } });
check("export E2E_VAR exit=0", jsonOf(r4).exit_code === 0, jsonOf(r4));

const r5 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "echo $E2E_VAR" } });
check("echo $E2E_VAR => hello", jsonOf(r5).stdout === "hello", jsonOf(r5));

const r6 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "false" } });
check("false exit_code=1", jsonOf(r6).exit_code === 1, jsonOf(r6));

const r7 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "seq 1 5" } });
check("seq 1 5 output", jsonOf(r7).stdout === "1\n2\n3\n4\n5", jsonOf(r7));

const g = await client.callTool({ name: "get_session", arguments: { session_id: sid } });
check("get_session connected", jsonOf(g).status === "connected", jsonOf(g));

const t0 = Date.now();
const r8 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "sleep 300", timeout: 3 } });
const elapsed = Date.now() - t0;
check("sleep 300 timeout -> command_timeout", r8.isError && jsonOf(r8).error === "command_timeout" && elapsed < 15000, { ...jsonOf(r8), elapsed: `${elapsed}ms` });

const g2 = await client.callTool({ name: "get_session", arguments: { session_id: sid } });
check("get_session busy after timeout", jsonOf(g2).status === "busy", jsonOf(g2));

const r9 = await client.callTool({ name: "cancel", arguments: { session_id: sid } });
check("cancel -> cancelled=true", jsonOf(r9).cancelled === true, jsonOf(r9));

const r10 = await client.callTool({ name: "execute", arguments: { session_id: sid, command: "echo recovered" } });
check("recovered after cancel", jsonOf(r10).stdout === "recovered" && jsonOf(r10).exit_code === 0, jsonOf(r10));

const inFlightExecution = client.callTool({
  name: "execute",
  arguments: { session_id: sid, command: "sleep 300", timeout: 30 },
});
const inFlightDeadline = Date.now() + 5000;
let inFlightStatus;
do {
  inFlightStatus = await client.callTool({ name: "get_session", arguments: { session_id: sid } });
  if (jsonOf(inFlightStatus).status === "busy") break;
  await new Promise((resolve) => setTimeout(resolve, 50));
} while (Date.now() < inFlightDeadline);
check("command remains pending while in flight", jsonOf(inFlightStatus).status === "busy", jsonOf(inFlightStatus));
const inFlightCancel = await client.callTool({ name: "cancel", arguments: { session_id: sid } });
check("in-flight cancel succeeds", jsonOf(inFlightCancel).cancelled === true, jsonOf(inFlightCancel));
const interruptedExecution = await inFlightExecution;
check(
  "in-flight execute is explicitly cancelled",
  interruptedExecution.isError && jsonOf(interruptedExecution).error === "command_cancelled",
  jsonOf(interruptedExecution),
);
const afterInFlightCancel = await client.callTool({ name: "get_session", arguments: { session_id: sid } });
check("session recovers after in-flight cancel", jsonOf(afterInFlightCancel).status === "connected", jsonOf(afterInFlightCancel));

const naturalTimeout = await client.callTool({
  name: "execute",
  arguments: { session_id: sid, command: "sleep 2", timeout: 1 },
});
check("short command reports timeout", naturalTimeout.isError && jsonOf(naturalTimeout).error === "command_timeout", jsonOf(naturalTimeout));
const naturalDeadline = Date.now() + 10000;
let afterNaturalCompletion;
do {
  afterNaturalCompletion = await client.callTool({ name: "get_session", arguments: { session_id: sid } });
  if (jsonOf(afterNaturalCompletion).status === "connected") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < naturalDeadline);
check("natural completion restores session", jsonOf(afterNaturalCompletion).status === "connected", jsonOf(afterNaturalCompletion));

const large = await client.callTool({
  name: "execute",
  arguments: { session_id: sid, command: "yes x | head -c 2097152", output_limit: 4096 },
});
const largeJson = jsonOf(large);
check(
  "large output is bounded",
  typeof largeJson.stdout === "string" && Buffer.byteLength(largeJson.stdout, "utf8") <= 4096 && largeJson.truncated === true,
  {
    byteLength: typeof largeJson.stdout === "string" ? Buffer.byteLength(largeJson.stdout, "utf8") : undefined,
    truncated: largeJson.truncated,
  },
);

const cl = await client.callTool({ name: "close", arguments: { session_id: sid } });
check("close session", !cl.isError, jsonOf(cl));

const reconnected = await client.callTool({ name: "connect", arguments: { asset: testAsset } });
const reconnectedJson = jsonOf(reconnected);
const newSid = reconnectedJson.session_id;
check("connect after close establishes a new session", !reconnected.isError && newSid !== sid, reconnectedJson);
if (typeof newSid === "string") {
  await login(newSid);
  await client.callTool({ name: "close", arguments: { session_id: newSid } });
}
const ls = await client.callTool({ name: "list_sessions", arguments: {} });
const listedSessions = jsonOf(ls).sessions;
check("list_sessions empty after close", Array.isArray(listedSessions) && listedSessions.length === 0, jsonOf(ls));

const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? "E2E ALL PASS" : `E2E FAILED: ${failed.length}/${results.length}`);
await client.close();
process.exit(failed.length === 0 ? 0 : 1);
