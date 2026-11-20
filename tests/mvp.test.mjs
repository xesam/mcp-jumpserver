import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../dist/config.js";
import { SessionError } from "../dist/errors.js";
import { truncateUtf8, truncateUtf8Tail } from "../dist/output.js";
import { cleanScreenText, readyMarkerPattern, readyProbeCommand, stripTerminalNoise } from "../dist/patterns.js";
import { hostMismatchWarning } from "../dist/session/hostcheck.js";
import { describePtySpawnFailure, findExecutableInPath, nodePtySpawnHelperPaths } from "../dist/session/ptycheck.js";
import { SessionManager } from "../dist/session/manager.js";
import { ExpectRunner } from "../dist/session/runner.js";

// 为伪造 runner 补齐登录阶段的方法；已有的同名方法优先
function withLogin(fake) {
  return {
    open: async () => {},
    currentScreen: () => ({ output: "", truncated: false }),
    sendInput: async () => ({ output: "", truncated: false }),
    takeUnreadScreen: () => ({ output: "", truncated: false }),
    confirmShell: async () => ({ ready: true, hostname: "asset-name", prompt_line: "" }),
    ...fake,
  };
}

async function connectReady(manager, asset) {
  const result = await manager.connect(asset);
  const confirmed = await manager.confirmShell(result.session_id);
  assert.equal(confirmed.ready, true);
  return result;
}

test("output limit is enforced on valid UTF-8 byte boundaries", () => {
  const cases = [
    { input: "abcdef", limit: 3, expected: "abc" },
    { input: "你好x", limit: 4, expected: "你" },
    { input: "你好x", limit: 2, expected: "" },
  ];

  for (const { input, limit, expected } of cases) {
    const result = truncateUtf8(input, limit);
    assert.equal(result.value, expected);
    assert.equal(result.truncated, true);
  }
  assert.deepEqual(truncateUtf8("abc", 3), { value: "abc", truncated: false });
});

test("tail truncation keeps the end on valid UTF-8 boundaries", () => {
  assert.deepEqual(truncateUtf8Tail("abcdef", 3), { value: "def", truncated: true });
  assert.deepEqual(truncateUtf8Tail("x你好", 4), { value: "好", truncated: true });
  assert.deepEqual(truncateUtf8Tail("abc", 3), { value: "abc", truncated: false });
});

test("screen text is cleaned without interpreting its content", () => {
  assert.equal(cleanScreenText("\x1b[32mID  NAME   \x1b[0m\r\n1   web    \r\nOpt> "), "ID  NAME\n1   web\nOpt>");
  assert.equal(cleanScreenText("loading\rdone"), "loading\ndone");
});

test("terminal noise from tput-style prompts is stripped", () => {
  assert.equal(stripTerminalNoise("\x1b(B\x1b[m[root@web ~]# \x07"), "[root@web ~]# ");
  assert.equal(stripTerminalNoise("\x1b)0\x1b=\x1b>\x1b[>4;1m\x1b[<u\x1b[=1cok"), "ok");
  assert.equal(stripTerminalNoise("\x1b]0;title\x07$ "), "$ ");
});

test("ready probe echo does not match the ready marker", () => {
  const cmd = readyProbeCommand("abc123");
  assert.equal(cmd, `printf '\\n__MCP_READY_abc123:%s\\n' "$?"`);
  assert.equal(readyMarkerPattern("abc123").test(cmd), false);
  assert.equal("\n__MCP_READY_abc123:0\n".match(readyMarkerPattern("abc123"))[1], "0");
});

test("host mismatch warning only appears when neither hostname nor prompt contains the asset", () => {
  assert.equal(hostMismatchWarning("web-01", "WEB-01.internal", "$"), undefined);
  assert.equal(hostMismatchWarning("web-01", "", "[root@web-01 ~]#"), undefined);
  assert.equal(
    hostMismatchWarning("web-01", "db-02", "[root@db-02 ~]#"),
    'Declared asset "web-01" was not found in hostname "db-02" or prompt line "[root@db-02 ~]#". The session may be on a different host. Confirm with the user before executing commands.',
  );
});

test("findExecutableInPath resolves executables and skips non-executable matches", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-patycheck-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(join(tempDir, "ssh"), "#!/bin/sh\n");
  await chmod(join(tempDir, "ssh"), 0o755);
  await writeFile(join(tempDir, "git"), "#!/bin/sh\n");
  await chmod(join(tempDir, "git"), 0o644);
  await writeFile(join(tempDir, "curl.exe"), "#!/bin/sh\n");

  assert.equal(findExecutableInPath("ssh", { PATH: tempDir }), join(tempDir, "ssh"));
  assert.equal(findExecutableInPath("git", { PATH: tempDir }), undefined);
  assert.equal(
    findExecutableInPath("ssh", { PATH: `${tempDir}${delimiter}${join(tempDir, "missing")}` }),
    join(tempDir, "ssh"),
  );
  assert.equal(findExecutableInPath("ssh", {}), undefined);
  assert.equal(findExecutableInPath("curl", { PATH: tempDir }), undefined);
  // Windows matches without the exec bit and falls back to the .exe suffix
  assert.equal(findExecutableInPath("git", { PATH: tempDir }, "win32"), join(tempDir, "git"));
  assert.equal(findExecutableInPath("curl", { PATH: tempDir }, "win32"), join(tempDir, "curl.exe"));
  assert.equal(findExecutableInPath("missing", { PATH: tempDir }, "win32"), undefined);
});

test("describePtySpawnFailure reports ssh and spawn-helper remediation", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-patycheck-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = tempDir;
  t.after(() => { process.env.PATH = originalPath; });

  const withoutSsh = describePtySpawnFailure(new Error("posix_spawnp failed."));
  assert.match(withoutSsh, /posix_spawnp failed\./);
  assert.match(withoutSsh, /ssh is not in PATH of the MCP server process/);

  await writeFile(join(tempDir, "ssh"), "#!/bin/sh\n");
  await chmod(join(tempDir, "ssh"), 0o755);
  const withSsh = describePtySpawnFailure("boom");
  assert.match(withSsh, /boom/);
  assert.doesNotMatch(withSsh, /ssh is not in PATH/);
});

test("expect config defaults apply to an omitted section and to omitted fields", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-defaults-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "mcp-jumpserver.yaml");
  const base = ["jumpserver:", "  sshTarget: local-test", "  auth:", "    method: ssh_key", "assets:", "  allowed:", "    - asset-name", ""];
  const defaults = { menu_timeout: 30, shell_timeout: 30, close_timeout: 10, quiet_period_ms: 1000, input_timeout: 10 };

  await writeFile(configPath, base.join("\n"));
  assert.deepEqual(loadConfig(configPath).expect, defaults);

  await writeFile(configPath, [...base, "expect:", "  menu_timeout: 5", ""].join("\n"));
  assert.deepEqual(loadConfig(configPath).expect, { ...defaults, menu_timeout: 5 });
});

test("session becomes executable after a timed-out command completes naturally", async () => {
  let onLateCompletion;
  let executeCalls = 0;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    async execute(_command, _timeout, _limit, onLate) {
      executeCalls += 1;
      if (executeCalls === 1) {
        onLateCompletion = onLate;
        throw new SessionError("command_timeout", "timed out");
      }
      return {
        session_id: "",
        exit_code: 0,
        stdout: "next command",
        duration_ms: 1,
        truncated: false,
        session_state: "busy",
      };
    },
    async cancel() { return { cancelled: true }; },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const config = loadConfig("mcp-jumpserver.example.yaml");
  const manager = new SessionManager(config, "test-owner", () => fakeRunner);
  const { session_id: sessionId } = await connectReady(manager, "asset-name");

  await assert.rejects(manager.execute(sessionId, "long-running"), (err) => err.code === "command_timeout");
  assert.equal(manager.getSession(sessionId).status, "busy");
  await assert.rejects(manager.execute(sessionId, "too-early"), (err) => err.code === "session_busy");

  onLateCompletion();
  assert.equal(manager.getSession(sessionId).status, "connected");
  assert.equal((await manager.execute(sessionId, "next")).stdout, "next command");
  await manager.shutdown();
});

test("concurrent connects to one asset share a single session", async () => {
  let finishConnect;
  let connectCalls = 0;
  const fakeRunner = withLogin({
    isAlive: true,
    open() {
      connectCalls += 1;
      return new Promise((resolve) => { finishConnect = resolve; });
    },
    async execute() {},
    async cancel() { return { cancelled: true }; },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "dedupe-owner", () => fakeRunner);
  const first = manager.connect("asset-name");
  await new Promise((resolve) => setImmediate(resolve));
  const second = manager.connect("asset-name");
  assert.equal(connectCalls, 1);
  finishConnect();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.session_id, secondResult.session_id);
  assert.equal(manager.listSessions().sessions.length, 1);
  await manager.shutdown();
});

test("a session owned by another client is rejected as forbidden", async () => {
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "client-a", () => loginFakeRunner());
  const { session_id: sessionId } = await manager.connect("asset-name");
  manager.sessions.get(sessionId).session.ownerId = "client-b";

  assert.throws(() => manager.getSession(sessionId), (err) => err.code === "session_forbidden");
  await assert.rejects(manager.sendInput(sessionId, "x"), (err) => err.code === "session_forbidden");
  await assert.rejects(manager.close(sessionId), (err) => err.code === "session_forbidden");
  await manager.shutdown();
});

test("different sessions execute concurrently without sharing results", async () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.assets.allowed.push("asset-two");
  const pendingExecutions = [];
  const manager = new SessionManager(config, "parallel-owner", () => withLogin({
    isAlive: true,
    async open() {},
    execute(command) {
      return new Promise((resolve) => pendingExecutions.push(() => resolve({
        exit_code: 0,
        stdout: command,
        duration_ms: 1,
        truncated: false,
        session_state: "busy",
      })));
    },
    async cancel() { return { cancelled: true }; },
    async close() {},
    dispose() { this.isAlive = false; },
  }));
  const [first, second] = await Promise.all([connectReady(manager, "asset-name"), connectReady(manager, "asset-two")]);
  const firstExecution = manager.execute(first.session_id, "first-result");
  const secondExecution = manager.execute(second.session_id, "second-result");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pendingExecutions.length, 2);
  pendingExecutions[1]();
  pendingExecutions[0]();
  const [firstResult, secondResult] = await Promise.all([firstExecution, secondExecution]);
  assert.equal(firstResult.stdout, "first-result");
  assert.equal(secondResult.stdout, "second-result");
  await manager.shutdown();
});

test("idle reaper closes idle sessions but preserves busy sessions", { timeout: 5000 }, async () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.session.idle_timeout = 1;
  const runners = [];
  const manager = new SessionManager(config, "idle-reaper-owner", () => {
    const runner = withLogin({
      isAlive: true,
      disposed: false,
      async open() {},
      execute() { return new Promise(() => {}); },
      async cancel() { return { cancelled: false }; },
      async close() {},
      dispose() {
        this.isAlive = false;
        this.disposed = true;
      },
    });
    runners.push(runner);
    return runner;
  });
  config.assets.allowed.push("asset-two", "asset-three");
  const idle = await connectReady(manager, "asset-name");
  const busy = await connectReady(manager, "asset-two");
  const interactive = await manager.connect("asset-three");
  assert.equal(interactive.status, "interactive");
  manager.startIdleReaper();
  void manager.execute(busy.session_id, "long-running");

  const isListed = (id) => manager.listSessions().sessions.some(({ session_id }) => session_id === id);
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline && (isListed(idle.session_id) || isListed(interactive.session_id))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(isListed(idle.session_id), false);
  assert.equal(isListed(interactive.session_id), false);
  assert.equal(manager.getSession(busy.session_id).status, "busy");
  assert.equal(runners[0].disposed, true);
  assert.equal(runners[1].disposed, false);
  assert.equal(runners[2].disposed, true);
  await manager.shutdown();
});

test("a concurrent command on the same session is rejected as busy", async () => {
  let finishExecution;
  let executeCalls = 0;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "busy-owner", () => withLogin({
    isAlive: true,
    async open() {},
    execute() {
      executeCalls += 1;
      return new Promise((resolve) => { finishExecution = resolve; });
    },
    async cancel() { return { cancelled: true }; },
    async close() {},
    dispose() { this.isAlive = false; },
  }));
  const { session_id: sessionId } = await connectReady(manager, "asset-name");
  const first = manager.execute(sessionId, "first");
  await assert.rejects(manager.execute(sessionId, "second"), (err) => err.code === "session_busy");
  assert.equal(executeCalls, 1);

  finishExecution({ exit_code: 0, stdout: "first", duration_ms: 1, truncated: false, session_state: "busy" });
  assert.equal((await first).stdout, "first");
  await manager.shutdown();
});

test("failed cancellation keeps an in-flight session busy until natural completion", async () => {
  let finishExecution;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "cancel-failed-owner", () => withLogin({
    isAlive: true,
    async open() {},
    execute() {
      return new Promise((resolve) => { finishExecution = resolve; });
    },
    async cancel() { return { cancelled: false }; },
    async close() {},
    dispose() { this.isAlive = false; },
  }));
  const { session_id: sessionId } = await connectReady(manager, "asset-name");
  const execution = manager.execute(sessionId, "long-running");
  await new Promise((resolve) => setImmediate(resolve));

  const cancel = await manager.cancel(sessionId);
  assert.equal(cancel.cancelled, false);
  assert.equal(cancel.session_state, "busy");
  await assert.rejects(manager.execute(sessionId, "must-not-overlap"), (err) => err.code === "session_busy");

  finishExecution({ exit_code: 0, stdout: "finished", duration_ms: 1, truncated: false, session_state: "busy" });
  assert.equal((await execution).stdout, "finished");
  assert.equal(manager.getSession(sessionId).status, "connected");
  await manager.shutdown();
});

test("natural completion during failed cancellation releases the session", async () => {
  let onLateCompletion;
  let finishCancel;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    async execute(_command, _timeout, _limit, onLate) {
      onLateCompletion = onLate;
      throw new SessionError("command_timeout", "timed out");
    },
    cancel() { return new Promise((resolve) => { finishCancel = resolve; }); },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "cancel-race-owner", () => fakeRunner);
  const { session_id: sessionId } = await connectReady(manager, "asset-name");

  await assert.rejects(manager.execute(sessionId, "long-running"), (err) => err.code === "command_timeout");
  const cancel = manager.cancel(sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  onLateCompletion();
  assert.equal(manager.getSession(sessionId).status, "busy");
  finishCancel({ cancelled: false });

  const result = await cancel;
  assert.equal(result.cancelled, false);
  assert.equal(result.session_state, "connected");
  assert.equal(manager.getSession(sessionId).status, "connected");
  await manager.shutdown();
});

test("natural completion during a throwing cancellation still releases the session", async () => {
  let onLateCompletion;
  let failCancel;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    async execute(_command, _timeout, _limit, onLate) {
      onLateCompletion = onLate;
      throw new SessionError("command_timeout", "timed out");
    },
    cancel() { return new Promise((resolve, reject) => { failCancel = reject; }); },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "cancel-throw-race-owner", () => fakeRunner);
  const { session_id: sessionId } = await connectReady(manager, "asset-name");

  await assert.rejects(manager.execute(sessionId, "long-running"), (err) => err.code === "command_timeout");
  const cancel = manager.cancel(sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  onLateCompletion();
  failCancel(new Error("cancel transport failed"));

  await assert.rejects(cancel, (err) => err.code === "cancel_failed");
  assert.equal(manager.getSession(sessionId).status, "connected");
  await manager.shutdown();
});

test("runner reports a completion marker that arrives after the timeout", async () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  const runner = new ExpectRunner(config);
  runner.alive = true;
  runner.pty = {
    write(data) {
      const token = data.match(/__MCP_DONE_([0-9a-f]+):/)?.[1];
      assert.ok(token);
      setTimeout(() => runner.handleData("still running\n__MCP_DONE_deadbeef:0\n"), 10);
      setTimeout(() => runner.handleData(`\n__MCP_DONE_${token}:0\n`), 80);
    },
    kill() {},
  };
  let completed = false;

  await assert.rejects(
    runner.execute("sleep", 0.005, 64, () => { completed = true; }),
    (err) => err.code === "command_timeout",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completed, false, "other output or another command's marker must not count as completion");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(completed, true);
  runner.dispose();
});

test("runner does not report cancellation when the timed-out command completes first", async () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  const runner = new ExpectRunner(config);
  runner.alive = true;
  runner.shellReady = true;
  let token;
  let completed = false;
  runner.pty = {
    write(data) {
      token = data.match(/__MCP_DONE_([0-9a-f]+):/)?.[1] ?? token;
      if (data === "\x03") {
        setTimeout(() => runner.handleData(`\n__MCP_DONE_${token}:0\n`), 5);
      }
      const readyToken = data.match(/__MCP_READY_([0-9a-f]+):/)?.[1];
      if (readyToken) setTimeout(() => runner.handleData(`\n__MCP_READY_${readyToken}:130\n`), 10);
    },
    kill() {},
  };

  await assert.rejects(
    runner.execute("sleep", 0.005, 64, () => { completed = true; }),
    (err) => err.code === "command_timeout",
  );
  assert.deepEqual(await runner.cancel(), { cancelled: false });
  assert.equal(completed, true);
  runner.dispose();
});

test("runner cancellation settles an in-flight command waiter", async () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  const runner = new ExpectRunner(config);
  runner.alive = true;
  runner.shellReady = true;
  runner.pty = {
    write(data) {
      const readyToken = data.match(/__MCP_READY_([0-9a-f]+):/)?.[1];
      if (readyToken) setTimeout(() => runner.handleData(`\n__MCP_READY_${readyToken}:130\n`), 10);
    },
    kill() {},
  };

  const execution = runner.execute("sleep", 5, 64);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await runner.cancel(), { cancelled: true });
  await assert.rejects(execution, (err) => err.code === "command_cancelled");
  runner.dispose();
});

test("manager returns to connected after cancelling an in-flight command", async () => {
  let finishExecute;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    execute() { return new Promise((resolve, reject) => { finishExecute = { resolve, reject }; }); },
    async cancel() {
      finishExecute.reject(new SessionError("command_cancelled", "interrupted"));
      return { cancelled: true };
    },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "active-cancel-owner", () => fakeRunner);
  const { session_id: sessionId } = await connectReady(manager, "asset-name");
  const execution = manager.execute(sessionId, "long-running");

  await new Promise((resolve) => setImmediate(resolve));
  const cancellation = await manager.cancel(sessionId);
  await assert.rejects(execution, (err) => err.code === "command_cancelled");
  assert.equal(cancellation.cancelled, true);
  assert.equal(manager.getSession(sessionId).status, "connected");
  await manager.shutdown();
});

test("close does not let an interrupted command reopen the session", async () => {
  let finishExecute;
  let finishCancel;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    execute() { return new Promise((resolve, reject) => { finishExecute = { resolve, reject }; }); },
    cancel() {
      finishExecute.reject(new SessionError("command_cancelled", "interrupted by close"));
      return new Promise((resolve) => { finishCancel = resolve; });
    },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "close-race-owner", () => fakeRunner);
  const { session_id: sessionId } = await connectReady(manager, "asset-name");
  const execution = manager.execute(sessionId, "long-running");
  await new Promise((resolve) => setImmediate(resolve));

  const closing = manager.close(sessionId);
  await assert.rejects(execution, (err) => err.code === "command_cancelled");
  assert.equal(manager.getSession(sessionId).status, "closing");
  finishCancel({ cancelled: true });
  await closing;
  assert.equal(manager.listSessions().sessions.length, 0);
  await manager.shutdown();
});

test("late completion does not reopen a session while cancel is in progress", async () => {
  let onLateCompletion;
  let finishCancel;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    async execute(_command, _timeout, _limit, onLate) {
      onLateCompletion = onLate;
      throw new SessionError("command_timeout", "timed out");
    },
    cancel() { return new Promise((resolve) => { finishCancel = resolve; }); },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "cancel-owner", () => fakeRunner);
  const { session_id: sessionId } = await connectReady(manager, "asset-name");
  await assert.rejects(manager.execute(sessionId, "long-running"), (err) => err.code === "command_timeout");

  const cancel = manager.cancel(sessionId);
  await assert.rejects(manager.cancel(sessionId), (err) => err.code === "cancel_failed");
  await assert.rejects(manager.close(sessionId), (err) => err.code === "session_busy");
  onLateCompletion();
  assert.equal(manager.getSession(sessionId).status, "busy");
  finishCancel({ cancelled: true });
  assert.equal((await cancel).session_state, "connected");
  await manager.shutdown();
});

test("connect replaces a session whose SSH runner has exited", async () => {
  const runners = [];
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "reconnect-owner", () => {
    const runner = withLogin({
      isAlive: true,
      async open() {},
      async execute() {},
      async cancel() { return { cancelled: true }; },
      async close() {},
      dispose() {
        this.disposed = (this.disposed ?? 0) + 1;
        this.isAlive = false;
      },
    });
    runners.push(runner);
    return runner;
  });

  const first = await manager.connect("asset-name");
  runners[0].isAlive = false;
  const second = await manager.connect("asset-name");
  assert.notEqual(second.session_id, first.session_id);
  assert.equal(second.reused, false);
  assert.equal(runners[0].disposed, 1);
  assert.deepEqual(manager.listSessions().sessions.map((s) => s.session_id), [second.session_id]);
  await manager.shutdown();
});

test("connect without ssh in PATH fails as ssh_not_found before creating a runner", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-nossh-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = tempDir;
  t.after(() => { process.env.PATH = originalPath; });

  let factoryCalls = 0;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "nossh-owner", () => {
    factoryCalls += 1;
    return withLogin({ isAlive: true });
  });
  await assert.rejects(manager.connect("asset-name"), (err) => {
    assert.equal(err.code, "ssh_not_found");
    assert.match(err.message, /^connect to asset-name: ssh executable not found in PATH/);
    return true;
  });
  assert.equal(factoryCalls, 0);
  assert.deepEqual(manager.listSessions(), { sessions: [] });
});

test("connect preserves pty_spawn_failed and prefixes the asset", async () => {
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "spawnfail-owner", () =>
    withLogin({
      isAlive: true,
      async open() {
        throw new SessionError("pty_spawn_failed", "node-pty failed to spawn the ssh process (posix_spawn failed: Permission denied).");
      },
      dispose() {},
    }),
  );
  await assert.rejects(manager.connect("asset-name"), (err) => {
    assert.equal(err.code, "pty_spawn_failed");
    assert.equal(
      err.message,
      "connect to asset-name failed: node-pty failed to spawn the ssh process (posix_spawn failed: Permission denied).",
    );
    return true;
  });
  assert.deepEqual(manager.listSessions(), { sessions: [] });
});

test("shutdown disposes every runner and drops all sessions", async () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.assets.allowed.push("asset-two");
  const disposed = [];
  const manager = new SessionManager(config, "shutdown-owner", () => {
    const index = disposed.push(0) - 1;
    return loginFakeRunner({ dispose() { disposed[index] += 1; } });
  });
  await manager.connect("asset-name");
  await connectReady(manager, "asset-two");

  await manager.shutdown();
  assert.deepEqual(disposed, [1, 1]);
  assert.deepEqual(manager.listSessions(), { sessions: [] });
});

test("SSH exit immediately marks an idle session disconnected", async () => {
  let reportExit;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    async execute() {},
    async cancel() { return { cancelled: true }; },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "exit-owner", (_config, onExit) => {
    reportExit = onExit;
    return fakeRunner;
  });
  const { session_id: sessionId } = await connectReady(manager, "asset-name");

  fakeRunner.isAlive = false;
  reportExit(255);
  assert.equal(manager.getSession(sessionId).status, "disconnected");
  await assert.rejects(manager.execute(sessionId, "must not run"), (err) => err.code === "session_disconnected");
  await manager.shutdown();
});

test("SSH exit during connection setup cannot be reported as connected", async () => {
  let reportExit;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {
      this.isAlive = false;
      reportExit(255);
    },
    async execute() {},
    async cancel() { return { cancelled: true }; },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "connect-exit-owner", (_config, onExit) => {
    reportExit = onExit;
    return fakeRunner;
  });

  await assert.rejects(manager.connect("asset-name"), (err) => err.code === "connect_failed");
  assert.equal(manager.listSessions().sessions.length, 0);
  await manager.shutdown();
});

test("SSH exit during a timed-out command is not overwritten as busy", async () => {
  let reportExit;
  let finishExecute;
  const fakeRunner = withLogin({
    isAlive: true,
    async open() {},
    execute() { return new Promise((resolve, reject) => { finishExecute = { resolve, reject }; }); },
    async cancel() { return { cancelled: false }; },
    async close() {},
    dispose() { this.isAlive = false; },
  });
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "execute-exit-owner", (_config, onExit) => {
    reportExit = onExit;
    return fakeRunner;
  });
  const { session_id: sessionId } = await connectReady(manager, "asset-name");

  const execution = manager.execute(sessionId, "sleep");
  await new Promise((resolve) => setImmediate(resolve));
  fakeRunner.isAlive = false;
  reportExit(255);
  finishExecute.reject(new SessionError("command_timeout", "timed out"));

  await assert.rejects(execution, (err) => err.code === "command_timeout");
  assert.equal(manager.getSession(sessionId).status, "disconnected");
  await manager.shutdown();
});

function loginFakeRunner(overrides = {}) {
  return withLogin({
    isAlive: true,
    async execute() {},
    async cancel() { return { cancelled: true }; },
    async close() {},
    dispose() { this.isAlive = false; },
    ...overrides,
  });
}

test("connect leaves the session interactive and returns the first screen", async () => {
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "first-screen-owner", () => loginFakeRunner({
    currentScreen: () => ({ output: "Select host:", truncated: false }),
  }));
  const result = await manager.connect("asset-name");
  assert.equal(result.status, "interactive");
  assert.equal(result.output, "Select host:");
  await assert.rejects(manager.execute(result.session_id, "pwd"), (err) => err.code === "session_not_ready");
  await assert.rejects(manager.cancel(result.session_id), (err) => err.code === "session_not_ready");
  await manager.shutdown();
});

test("connect reuses an interactive session and reports its current screen", async () => {
  let screenReads = 0;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "reuse-interactive-owner", () => loginFakeRunner({
    currentScreen: () => ({ output: `screen-${++screenReads}`, truncated: false }),
  }));
  const first = await manager.connect("asset-name");
  const second = await manager.connect("asset-name");
  assert.deepEqual(
    { id: second.session_id, status: second.status, reused: second.reused, output: second.output },
    { id: first.session_id, status: "interactive", reused: true, output: "screen-2" },
  );
  await manager.confirmShell(first.session_id);
  const third = await manager.connect("asset-name");
  assert.equal(third.status, "connected");
  assert.equal(third.output, undefined);
  await manager.shutdown();
});

test("concurrent connects report the shared session's interactive state", async () => {
  let finishOpen;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "shared-state-owner", () => loginFakeRunner({
    open() { return new Promise((resolve) => { finishOpen = resolve; }); },
    currentScreen: () => ({ output: "Select host:", truncated: false }),
  }));
  const first = manager.connect("asset-name");
  await new Promise((resolve) => setImmediate(resolve));
  const second = manager.connect("asset-name");
  finishOpen();
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.equal(result.status, "interactive");
    assert.equal(result.output, "Select host:");
  }
  assert.deepEqual(results.map((r) => r.reused), [false, true]);
  await manager.shutdown();
});

test("confirm_shell moves the session to connected and warns on host mismatch", async () => {
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "mismatch-owner", () => loginFakeRunner({
    confirmShell: async () => ({ ready: true, hostname: "db-02", prompt_line: "[root@db-02 ~]#" }),
  }));
  const { session_id: sessionId } = await manager.connect("asset-name");
  const confirmed = await manager.confirmShell(sessionId);
  assert.deepEqual(confirmed, {
    session_id: sessionId,
    ready: true,
    session_state: "connected",
    hostname: "db-02",
    prompt_line: "[root@db-02 ~]#",
    warning: hostMismatchWarning("asset-name", "db-02", "[root@db-02 ~]#"),
  });
  assert.match(confirmed.warning, /Declared asset "asset-name"/);
  await assert.rejects(manager.sendInput(sessionId, "x"), (err) => err.code === "session_not_interactive");
  await manager.shutdown();
});

test("failed confirm_shell keeps the session interactive", async () => {
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "not-ready-owner", () => loginFakeRunner({
    confirmShell: async () => ({ ready: false, output: "No asset found", truncated: false }),
  }));
  const { session_id: sessionId } = await manager.connect("asset-name");
  const confirmed = await manager.confirmShell(sessionId);
  assert.deepEqual(
    { ready: confirmed.ready, state: confirmed.session_state, output: confirmed.output },
    { ready: false, state: "interactive", output: "No asset found" },
  );
  assert.equal(confirmed.warning, undefined);
  await manager.shutdown();
});

test("concurrent input on one interactive session is rejected as busy", async () => {
  let finishInput;
  const inputs = [];
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "input-busy-owner", () => loginFakeRunner({
    sendInput(input, enter, waitSec, outputLimit) {
      inputs.push({ input, enter, waitSec, outputLimit });
      return new Promise((resolve) => { finishInput = resolve; });
    },
  }));
  const { session_id: sessionId } = await manager.connect("asset-name");
  const first = manager.sendInput(sessionId, "asset-name");
  await assert.rejects(manager.sendInput(sessionId, "again"), (err) => err.code === "session_busy");
  await assert.rejects(manager.confirmShell(sessionId), (err) => err.code === "session_busy");
  assert.deepEqual(inputs, [{ input: "asset-name", enter: true, waitSec: 10, outputLimit: 65536 }]);

  finishInput({ output: "Select account:", truncated: false });
  assert.equal((await first).output, "Select account:");
  const second = manager.sendInput(sessionId, "", false, 3);
  finishInput({ output: "", truncated: false });
  assert.equal((await second).session_state, "interactive");
  assert.deepEqual(inputs[1], { input: "", enter: false, waitSec: 3, outputLimit: 65536 });
  await manager.shutdown();
});

test("close during an in-flight send_input disposes the runner", async () => {
  let releaseWait;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "input-close-owner", () => loginFakeRunner({
    sendInput() { return new Promise((resolve) => { releaseWait = resolve; }); },
    dispose() {
      this.isAlive = false;
      releaseWait?.({ output: "", truncated: false });
    },
  }));
  const { session_id: sessionId } = await manager.connect("asset-name");
  const input = manager.sendInput(sessionId, "asset-name");
  await new Promise((resolve) => setImmediate(resolve));
  await manager.close(sessionId);
  assert.equal((await input).session_state, "closed");
  assert.equal(manager.listSessions().sessions.length, 0);
  await manager.shutdown();
});

test("SSH exit during login is reported through send_input", async () => {
  let reportExit;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "login-exit-owner", (_config, onExit) => {
    reportExit = onExit;
    return loginFakeRunner({
      async sendInput() {
        this.isAlive = false;
        reportExit(255);
        return { output: "Permission denied", truncated: false };
      },
    });
  });
  const { session_id: sessionId } = await manager.connect("asset-name");
  const result = await manager.sendInput(sessionId, "wrong");
  assert.equal(result.session_state, "disconnected");
  assert.equal(result.output, "Permission denied");
  await manager.shutdown();
});

test("unread login output survives an ssh exit between calls and is returned once", async () => {
  let reportExit;
  const writes = [];
  let unread = { output: "MFA verification failed", truncated: false };
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "exit-between-owner", (_config, onExit) => {
    reportExit = onExit;
    return loginFakeRunner({
      async sendInput(input) { writes.push(input); return { output: "", truncated: false }; },
      takeUnreadScreen() {
        const screen = unread;
        unread = { output: "", truncated: false };
        return screen;
      },
    });
  });
  const { session_id: sessionId } = await manager.connect("asset-name");
  const runner = manager.sessions.get(sessionId).runner;
  runner.isAlive = false;
  reportExit(1);
  assert.deepEqual(await manager.sendInput(sessionId, "123456"), {
    session_id: sessionId, output: "MFA verification failed", truncated: false, session_state: "disconnected",
  });
  await assert.rejects(manager.sendInput(sessionId, "123456"), (err) => err.code === "session_disconnected");
  await assert.rejects(manager.confirmShell(sessionId), (err) => err.code === "session_disconnected");
  assert.deepEqual(writes, []);
  await manager.shutdown();
});

test("a session whose ssh exited does not count against max_sessions", async () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.session.max_sessions = 1;
  config.assets.allowed.push("asset-two");
  let reportExit;
  const runners = [];
  const manager = new SessionManager(config, "max-sessions-owner", (_config, onExit) => {
    reportExit = onExit;
    const runner = loginFakeRunner();
    runners.push(runner);
    return runner;
  });
  await manager.connect("asset-name");
  runners[0].isAlive = false;
  reportExit(255);
  const second = await manager.connect("asset-two");
  assert.equal(second.status, "interactive");
  assert.deepEqual(manager.listSessions().sessions.map((s) => s.session_id), [second.session_id]);
  await manager.shutdown();
});

test("SSH exit while confirm_shell is in flight is reported as disconnected", async () => {
  let reportExit;
  const manager = new SessionManager(loadConfig("mcp-jumpserver.example.yaml"), "confirm-exit-owner", (_config, onExit) => {
    reportExit = onExit;
    return loginFakeRunner({
      async confirmShell() {
        this.isAlive = false;
        reportExit(255);
        return { ready: true, hostname: "", prompt_line: "" };
      },
    });
  });
  const { session_id: sessionId } = await manager.connect("asset-name");
  await assert.rejects(manager.confirmShell(sessionId), (err) => err.code === "session_disconnected");
  assert.equal(manager.getSession(sessionId).status, "disconnected");
  await manager.shutdown();
});

function interactiveRunner(onWrite = () => {}) {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.expect.quiet_period_ms = 20;
  const runner = new ExpectRunner(config);
  const writes = [];
  const resizes = [];
  runner.alive = true;
  runner.pty = {
    write(data) {
      writes.push(data);
      onWrite(data, runner);
    },
    kill() {},
    resize(cols, rows) {
      resizes.push([cols, rows]);
    },
  };
  return { config, runner, writes, resizes };
}

test("sendInput returns output that arrived between calls", async () => {
  const { runner, writes } = interactiveRunner((data, r) => {
    if (data === "2\r") setTimeout(() => r.handleData("picked 2\r\n"), 5);
  });
  runner.handleData("first\r\n");
  assert.deepEqual(runner.currentScreen(1024), { output: "first", truncated: false });
  runner.handleData("late-result\r\n");
  const result = await runner.sendInput("2", true, 1, 1024);
  assert.equal(result.output, "late-result\npicked 2");
  assert.deepEqual(writes, ["2\r"]);
  runner.dispose();
});

test("sendInput with no response returns empty output after the wait limit", async () => {
  const { runner } = interactiveRunner();
  const started = Date.now();
  assert.deepEqual(await runner.sendInput("x", false, 0.1, 1024), { output: "", truncated: false });
  assert.ok(Date.now() - started >= 100);
  runner.dispose();
});

test("screen text beyond the limit keeps its tail", async () => {
  const { runner } = interactiveRunner();
  runner.handleData("0123456789");
  assert.deepEqual(runner.currentScreen(4), { output: "6789", truncated: true });
  runner.dispose();
});

test("confirmShell reports not ready when no marker arrives and keeps the session interactive", async () => {
  const { config, runner, resizes } = interactiveRunner((data, r) => {
    if (data.includes("__MCP_READY_")) setTimeout(() => r.handleData("No asset found\r\n"), 5);
  });
  config.expect.shell_timeout = 0.05;
  const probe = await runner.confirmShell(1024);
  assert.equal(probe.ready, false);
  assert.match(probe.output, /No asset found/);
  assert.equal(runner.shellReady, false);
  assert.deepEqual(resizes, [[2048, 24], [200, 24]]);
  runner.dispose();
});

test("confirmShell captures prompt line and hostname once the marker arrives", async () => {
  const { runner, resizes } = interactiveRunner((data, r) => {
    const readyToken = data.match(/__MCP_READY_([0-9a-f]+):/)?.[1];
    if (readyToken) setTimeout(() => r.handleData(`\n__MCP_READY_${readyToken}:0\n`), 5);
    const doneToken = data.match(/__MCP_DONE_([0-9a-f]+):/)?.[1];
    if (doneToken) setTimeout(() => r.handleData(`\nweb-01\n\n__MCP_DONE_${doneToken}:0\n`), 5);
  });
  runner.handleData("Last login: today\r\n[root@web-01 ~]# ");
  assert.deepEqual(await runner.confirmShell(1024), {
    ready: true, hostname: "web-01", prompt_line: "[root@web-01 ~]#",
  });
  assert.equal(runner.shellReady, true);
  assert.deepEqual(resizes, [[2048, 24]]);
  runner.dispose();
});

test("confirmShell reports an empty hostname when the hostname command times out", async () => {
  const { config, runner } = interactiveRunner((data, r) => {
    const readyToken = data.match(/__MCP_READY_([0-9a-f]+):/)?.[1];
    if (readyToken) setTimeout(() => r.handleData(`\n__MCP_READY_${readyToken}:0\n`), 5);
  });
  config.expect.shell_timeout = 0.05;
  runner.handleData("$ ");
  assert.deepEqual(await runner.confirmShell(1024), { ready: true, hostname: "", prompt_line: "$" });
  runner.dispose();
});

test("confirmShell reports an empty hostname when the hostname command exits non-zero", async () => {
  const { runner } = interactiveRunner((data, r) => {
    const readyToken = data.match(/__MCP_READY_([0-9a-f]+):/)?.[1];
    if (readyToken) setTimeout(() => r.handleData(`\n__MCP_READY_${readyToken}:0\n`), 5);
    const doneToken = data.match(/__MCP_DONE_([0-9a-f]+):/)?.[1];
    if (doneToken) {
      setTimeout(() => r.handleData(`\n-bash: hostname: command not found\n\n__MCP_DONE_${doneToken}:127\n`), 5);
    }
  });
  runner.handleData("$ ");
  assert.deepEqual(await runner.confirmShell(1024), { ready: true, hostname: "", prompt_line: "$" });
  runner.dispose();
});

test("an empty read keeps the last returned screen for currentScreen", async () => {
  const { runner } = interactiveRunner();
  runner.handleData("[root@web-01 ~]# ");
  assert.equal(runner.currentScreen(1024).output, "[root@web-01 ~]#");
  assert.deepEqual(await runner.sendInput("", false, 0.05, 1024), { output: "", truncated: false });
  assert.equal(runner.currentScreen(1024).output, "[root@web-01 ~]#");
  runner.dispose();
});

test("an empty read keeps the prompt line for confirmShell", async () => {
  const { runner } = interactiveRunner((data, r) => {
    const readyToken = data.match(/__MCP_READY_([0-9a-f]+):/)?.[1];
    if (readyToken) setTimeout(() => r.handleData(`\n__MCP_READY_${readyToken}:0\n`), 5);
    const doneToken = data.match(/__MCP_DONE_([0-9a-f]+):/)?.[1];
    if (doneToken) setTimeout(() => r.handleData(`\nweb-01\n\n__MCP_DONE_${doneToken}:0\n`), 5);
  });
  runner.handleData("[root@web-01 ~]# ");
  runner.currentScreen(1024);
  assert.equal((await runner.sendInput("", false, 0.05, 1024)).output, "");
  const probe = await runner.confirmShell(1024);
  assert.equal(probe.prompt_line, "[root@web-01 ~]#");
  runner.dispose();
});

test("takeUnreadScreen returns unread login output once after ssh exits", async () => {
  const { runner } = interactiveRunner();
  runner.handleData("MFA failed\r\n");
  runner.handleExit(1);
  assert.deepEqual(runner.takeUnreadScreen(1024), { output: "MFA failed", truncated: false });
  assert.deepEqual(runner.takeUnreadScreen(1024), { output: "", truncated: false });
});

test("execute strips a stray ready marker from stdout", async () => {
  const { runner } = interactiveRunner((data, r) => {
    const doneToken = data.match(/__MCP_DONE_([0-9a-f]+):/)?.[1];
    if (doneToken) {
      setTimeout(() => r.handleData(`\n__MCP_READY_0123abcd:130\nok\n\n__MCP_DONE_${doneToken}:0\n`), 5);
    }
  });
  runner.shellReady = true;
  const result = await runner.execute("true", 1, 1024);
  assert.equal(result.stdout, "ok");
  assert.equal(result.exit_code, 0);
  runner.dispose();
});

test("sendInput returns at the hard cap while output keeps streaming", { timeout: 2000 }, async () => {
  const { runner } = interactiveRunner();
  const stream = setInterval(() => runner.handleData("."), 5);
  try {
    const started = Date.now();
    const result = await runner.sendInput("x", false, 0.1, 1024);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100 && elapsed <= 300, `returned after ${elapsed} ms`);
    assert.match(result.output, /^\.+$/);
  } finally {
    clearInterval(stream);
    runner.dispose();
  }
});

test("dispose releases a pending sendInput wait", { timeout: 1000 }, async () => {
  const { runner } = interactiveRunner();
  const pending = runner.sendInput("x", true, 30, 1024);
  runner.dispose();
  assert.deepEqual(await pending, { output: "", truncated: false });
});

test("close without a confirmed shell sends nothing", async () => {
  const { runner, writes } = interactiveRunner();
  await runner.close();
  assert.deepEqual(writes, []);
  runner.dispose();
});

test("sendInput without output sleeps until the wait limit instead of polling", async () => {
  const { runner } = interactiveRunner();
  const originalSetTimeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = (...args) => {
    timers += 1;
    return originalSetTimeout(...args);
  };
  const started = Date.now();
  try {
    assert.deepEqual(await runner.sendInput("x", true, 0.2, 1024), { output: "", truncated: false });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.ok(Date.now() - started >= 200);
  assert.ok(timers <= 3, `scheduled ${timers} timers`);
  runner.dispose();
});

test("sendInput wakes on output that arrives after the first quiet period", async () => {
  const { runner } = interactiveRunner((data, r) => {
    if (data === "slow\r") setTimeout(() => r.handleData("answer\r\n"), 60);
  });
  const started = Date.now();
  assert.deepEqual(await runner.sendInput("slow", true, 5, 1024), { output: "answer", truncated: false });
  assert.ok(Date.now() - started < 1000);
  runner.dispose();
});

test("currentScreen reports truncation when the combined screen exceeds the buffer", async () => {
  const { runner } = interactiveRunner();
  // Backspaces only move the cursor within their own line, so only the buffer cut can drop "head".
  runner.screenReturned = `head\n${"\x08".repeat(2 * 1024 * 1024)}`;
  runner.handleData("tail");
  assert.deepEqual(runner.currentScreen(1024), { output: "tail", truncated: true });
  runner.dispose();
});

test("close on a confirmed shell sends exit and returns once output is quiet", async () => {
  const { runner, writes } = interactiveRunner((data, r) => {
    if (data === "exit\r") setTimeout(() => r.handleData("exit\r\nlogout\r\n"), 50);
  });
  runner.shellReady = true;
  const started = Date.now();
  await runner.close();
  const elapsed = Date.now() - started;
  assert.deepEqual(writes, ["exit\r"]);
  // Output arrives after 50 ms and the quiet period is 20 ms.
  assert.ok(elapsed >= 65 && elapsed < 1000, `returned after ${elapsed} ms`);
  runner.dispose();
});

test("screen text applies backspaces the way a terminal displays them", () => {
  assert.equal(cleanScreenText("progress 0.0\b\b\b0.1\b\b\b0.2"), "progress 0.2");
  assert.equal(cleanScreenText("abc\b \b"), "ab");
  assert.equal(cleanScreenText("你好\b\b  \b\b"), "你");
  assert.equal(cleanScreenText("\b\bx"), "x");
});

test("confirmShell reads the prompt line that the probe was typed at", async () => {
  const { runner } = interactiveRunner((data, r) => {
    const ready = data.match(/__MCP_READY_([0-9a-f]+):/)?.[1];
    if (ready) {
      // The prompt only shows up after confirm_shell was called; the shell echoes the probe after it.
      r.handleData(`${data.trimEnd()}\r\n 0.9 1.0\r\nLast login: today\r\n[dev@web-01 ~]$ ${data.trimEnd()}\r\n\r\n__MCP_READY_${ready}:0\r\n[dev@web-01 ~]$ `);
      return;
    }
    const done = data.match(/__MCP_DONE_([0-9a-f]+):/)?.[1];
    if (done) r.handleData(`\nweb-01\n\n__MCP_DONE_${done}:0\n`);
  });
  runner.handleData("connecting to dev@10.0.0.1  0.1 0.2");
  assert.deepEqual(await runner.confirmShell(1024), {
    ready: true, hostname: "web-01", prompt_line: "[dev@web-01 ~]$",
  });
  runner.dispose();
});

test("cancel types the probe only after the terminal has reacted to Ctrl+C", async () => {
  const { runner, writes } = interactiveRunner();
  runner.shellReady = true;
  let flushing = false;
  runner.pty.write = (data) => {
    writes.push(data);
    if (data === "\x03") {
      flushing = true;
      setTimeout(() => {
        flushing = false;
        runner.handleData("^C\r\n$ ");
      }, 10);
      return;
    }
    // Input typed while the tty is still handling the interrupt loses its first character.
    const received = flushing ? data.slice(1) : data;
    const token = received.match(/^printf '\\n__MCP_READY_([0-9a-f]+):/)?.[1];
    if (token) setTimeout(() => runner.handleData(`\n__MCP_READY_${token}:130\n`), 5);
  };
  assert.deepEqual(await runner.cancel(), { cancelled: true });
  assert.equal(writes[0], "\x03");
  runner.dispose();
});

test("cancel reports failure when the probe marker never arrives", async () => {
  const { config, runner, writes } = interactiveRunner();
  config.expect.close_timeout = 0.05;
  runner.shellReady = true;
  assert.deepEqual(await runner.cancel(), { cancelled: false });
  assert.equal(writes[0], "\x03");
  assert.match(writes[1], /__MCP_READY_[0-9a-f]+:%s/);
  runner.dispose();
});

test("open reports the exit code alone when ssh exits without output", { timeout: 5000 }, async (t) => {
  if (process.platform === "win32") return t.skip("requires a Unix PTY and shell");
  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-open-silent-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(join(tempDir, "ssh"), "#!/bin/sh\nexit 3\n");
  await chmod(join(tempDir, "ssh"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${delimiter}${originalPath ?? ""}`;
  t.after(() => { process.env.PATH = originalPath; });
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.expect.quiet_period_ms = 20;
  const runner = new ExpectRunner(config);
  await assert.rejects(runner.open(), (err) => {
    assert.equal(err.code, "session_disconnected");
    assert.equal(err.message, "ssh exited with code 3");
    return true;
  });
  runner.dispose();
});

test("open reports the terminal tail when ssh exits during login", { timeout: 5000 }, async (t) => {
  if (process.platform === "win32") return t.skip("requires a Unix PTY and shell");
  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-open-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(join(tempDir, "ssh"), "#!/bin/sh\nprintf 'Permission denied (publickey).\\r\\n'\nexit 255\n");
  await chmod(join(tempDir, "ssh"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${delimiter}${originalPath ?? ""}`;
  t.after(() => { process.env.PATH = originalPath; });
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.expect.quiet_period_ms = 20;
  const runner = new ExpectRunner(config);
  await assert.rejects(runner.open(), (err) => {
    assert.equal(err.code, "session_disconnected");
    assert.equal(err.message, "ssh exited with code 255: Permission denied (publickey).");
    return true;
  });
  runner.dispose();
});

test("configured SSH keepalive interval is passed to OpenSSH", () => {
  const config = loadConfig("mcp-jumpserver.example.yaml");
  config.ssh.keepalive_interval = 17;
  const runner = new ExpectRunner(config);
  assert.deepEqual(runner.sshArgs().slice(0, 6), [
    "-o",
    `ConnectTimeout=${config.ssh.connect_timeout}`,
    "-o",
    "ServerAliveInterval=17",
    "-o",
    "ServerAliveCountMax=3",
  ]);
});

test("open wraps a non-executable spawn-helper as pty_spawn_failed with remediation", { timeout: 5000 }, async (t) => {
  if (process.platform === "win32") return t.skip("requires a Unix PTY and shell");
  const helpers = nodePtySpawnHelperPaths().filter((h) => h.executable);
  if (helpers.length === 0) return t.skip("no executable node-pty spawn-helper found");
  const originalModes = [];
  for (const helper of helpers) {
    originalModes.push((await stat(helper.path)).mode);
    await chmod(helper.path, 0o644);
  }
  t.after(async () => {
    for (const [index, helper] of helpers.entries()) await chmod(helper.path, originalModes[index]);
  });

  const config = loadConfig("mcp-jumpserver.example.yaml");
  const runner = new ExpectRunner(config);
  try {
    await assert.rejects(runner.open(), (err) => {
      assert.equal(err.code, "pty_spawn_failed");
      assert.match(err.message, /posix_spawn(p)? failed/);
      assert.match(err.message, /chmod \+x/);
      return true;
    });
  } finally {
    runner.dispose();
  }
});

const execFileAsync = promisify(execFile);

const FAKE_SSH_SCRIPT = [
  "#!/bin/sh",
  "printf '%s\\n' \"$$\" > \"$SSH_TEST_PIDFILE\"",
  "while :; do",
  "  printf 'Select host: '",
  "  IFS= read -r line",
  "  [ \"$line\" = \"asset-name\" ] && break",
  "  printf 'no such host\\n'",
  "done",
  "export PS1=\"$SSH_TEST_PS1\"",
  "exec /bin/bash --noprofile --norc -i",
  "",
].join("\n");

test("stdio shutdown cleans the PTY and abrupt SSH child exit disconnects the session", { timeout: 20000 }, async (t) => {
  if (process.platform === "win32") return t.skip("requires a Unix PTY and shell");

  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-lifecycle-"));
  const binDir = join(tempDir, "bin");
  const pidFile = join(tempDir, "ssh.pid");
  await mkdir(binDir);
  const fakeSsh = join(binDir, "ssh");
  await writeFile(fakeSsh, FAKE_SSH_SCRIPT);
  await chmod(fakeSsh, 0o755);
  const configPath = join(tempDir, "mcp-jumpserver.yaml");
  await writeFile(
    configPath,
    [
      "jumpserver:",
      "  sshTarget: local-test",
      "  auth:",
      "    method: ssh_key",
      "assets:",
      "  allowed:",
      "    - asset-name",
      "expect:",
      "  menu_timeout: 5",
      "  shell_timeout: 5",
      "  close_timeout: 1",
      "  quiet_period_ms: 100",
      "",
    ].join("\n"),
  );
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      MCP_JUMPSERVER_CONFIG: configPath,
      SSH_TEST_PIDFILE: pidFile,
      SSH_TEST_PS1: "asset-name# ",
    },
  });
  const client = new Client({ name: "lifecycle-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const connected = await client.callTool({ name: "connect", arguments: { asset: "asset-name" } });
    assert.equal(connected.isError, undefined, connected.content?.[0]?.text);
    let sshPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(Number.isInteger(sshPid) && sshPid > 0);

    const connectResult = JSON.parse(connected.content[0].text);
    assert.equal(connectResult.status, "interactive", connected.content[0].text);
    assert.match(connectResult.output, /Select host:/, connected.content[0].text);
    const sessionId = connectResult.session_id;
    const selected = await client.callTool({ name: "send_input", arguments: { session_id: sessionId, input: "asset-name" } });
    assert.equal(selected.isError, undefined, selected.content?.[0]?.text);
    const shell = await client.callTool({ name: "confirm_shell", arguments: { session_id: sessionId } });
    const shellResult = JSON.parse(shell.content[0].text);
    assert.equal(shellResult.ready, true, shell.content[0].text);
    assert.equal(shellResult.warning, undefined, shell.content[0].text);
    const trailingComment = await client.callTool({
      name: "execute",
      arguments: { session_id: sessionId, command: "printf 'comment-ok' # trailing comment", timeout: 2 },
    });
    assert.equal(trailingComment.isError, undefined, trailingComment.content?.[0]?.text);
    assert.equal(JSON.parse(trailingComment.content[0].text).stdout, "comment-ok", trailingComment.content[0].text);
    const promptLikeOutput = await client.callTool({
      name: "execute",
      arguments: {
        session_id: sessionId,
        command: "printf '%s\\n' '[test@asset-name ~]$ ' 'still-here'",
      },
    });
    assert.equal(promptLikeOutput.isError, undefined, promptLikeOutput.content?.[0]?.text);
    assert.equal(
      JSON.parse(promptLikeOutput.content[0].text).stdout,
      "[test@asset-name ~]$ \nstill-here",
      promptLikeOutput.content[0].text,
    );
    const anchorLikeInput = await client.callTool({
      name: "execute",
      arguments: {
        session_id: sessionId,
        command: "printf 'anchor-ok'; # ' \"$?\"",
      },
    });
    assert.equal(anchorLikeInput.isError, undefined, anchorLikeInput.content?.[0]?.text);
    assert.equal(JSON.parse(anchorLikeInput.content[0].text).stdout, "anchor-ok", anchorLikeInput.content[0].text);

    const execution = client.callTool({
      name: "execute",
      arguments: { session_id: sessionId, command: "sleep 30", timeout: 10 },
    });
    const busyDeadline = Date.now() + 2000;
    let session;
    do {
      session = await client.callTool({ name: "get_session", arguments: { session_id: sessionId } });
      if (JSON.parse(session.content[0].text).status === "busy") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < busyDeadline);
    assert.equal(JSON.parse(session.content[0].text).status, "busy");
    // Ctrl+C only interrupts the command once sleep is running as a child of the fake shell.
    const sleepDeadline = Date.now() + 2000;
    let sleepRunning = false;
    while (!sleepRunning && Date.now() < sleepDeadline) {
      sleepRunning = await execFileAsync("pgrep", ["-P", String(sshPid), "sleep"]).then(() => true, (err) => {
        if (err.code === "ENOENT") throw new Error("this test requires pgrep");
        return false;
      });
      if (!sleepRunning) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(sleepRunning, true, "sleep did not start");

    const cancelled = await client.callTool({ name: "cancel", arguments: { session_id: sessionId } });
    assert.equal(JSON.parse(cancelled.content[0].text).cancelled, true, cancelled.content?.[0]?.text);
    const executionResult = await execution;
    // Depends on the target shell: bash 3.2 still runs the rest of the interrupted line, so the
    // completion marker arrives with exit code 130; bash 5 abandons the line, so cancel rejects the command.
    const executionOutcome = JSON.parse(executionResult.content[0].text);
    if (executionResult.isError) {
      assert.equal(executionOutcome.error, "command_cancelled", executionResult.content[0].text);
    } else {
      assert.equal(executionOutcome.exit_code, 130, executionResult.content[0].text);
    }
    const recovered = await client.callTool({ name: "get_session", arguments: { session_id: sessionId } });
    assert.equal(JSON.parse(recovered.content[0].text).status, "connected");
    const postCancel = await client.callTool({
      name: "execute",
      arguments: { session_id: sessionId, command: "printf 'post-cancel-ok'" },
    });
    assert.equal(postCancel.isError, undefined, postCancel.content?.[0]?.text);
    assert.equal(JSON.parse(postCancel.content[0].text).stdout, "post-cancel-ok", postCancel.content[0].text);

    const ignoresInterrupt = await client.callTool({
      name: "execute",
      arguments: { session_id: sessionId, command: "trap '' INT; sleep 6", timeout: 1 },
    });
    assert.equal(ignoresInterrupt.isError, true, ignoresInterrupt.content?.[0]?.text);
    assert.equal(JSON.parse(ignoresInterrupt.content[0].text).error, "command_timeout");
    const failedCancel = await client.callTool({ name: "cancel", arguments: { session_id: sessionId } });
    assert.equal(JSON.parse(failedCancel.content[0].text).cancelled, false, failedCancel.content?.[0]?.text);
    const busyAfterFailedCancel = await client.callTool({ name: "get_session", arguments: { session_id: sessionId } });
    assert.equal(JSON.parse(busyAfterFailedCancel.content[0].text).status, "busy");
    const naturalCompletionDeadline = Date.now() + 8000;
    let afterNaturalCompletion;
    do {
      afterNaturalCompletion = await client.callTool({ name: "get_session", arguments: { session_id: sessionId } });
      if (JSON.parse(afterNaturalCompletion.content[0].text).status === "connected") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < naturalCompletionDeadline);
    assert.equal(JSON.parse(afterNaturalCompletion.content[0].text).status, "connected");
    const resetInterruptTrap = await client.callTool({
      name: "execute",
      arguments: { session_id: sessionId, command: "trap - INT" },
    });
    assert.equal(resetInterruptTrap.isError, undefined, resetInterruptTrap.content?.[0]?.text);

    process.kill(sshPid, "SIGKILL");
    const disconnectDeadline = Date.now() + 2000;
    let disconnectedStatus;
    do {
      disconnectedStatus = await client.callTool({ name: "get_session", arguments: { session_id: sessionId } });
      if (JSON.parse(disconnectedStatus.content[0].text).status === "disconnected") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < disconnectDeadline);
    assert.equal(JSON.parse(disconnectedStatus.content[0].text).status, "disconnected");
    const disconnectedExecution = await client.callTool({
      name: "execute",
      arguments: { session_id: sessionId, command: "printf must-not-run" },
    });
    assert.equal(disconnectedExecution.isError, true);
    assert.equal(JSON.parse(disconnectedExecution.content[0].text).error, "session_disconnected");

    const reconnected = await client.callTool({ name: "connect", arguments: { asset: "asset-name" } });
    assert.equal(reconnected.isError, undefined, reconnected.content?.[0]?.text);
    assert.notEqual(JSON.parse(reconnected.content[0].text).session_id, sessionId);
    const killedPid = sshPid;
    sshPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(Number.isInteger(sshPid) && sshPid > 0);
    assert.notEqual(sshPid, killedPid);

    const serverProcess = transport._process;
    assert.ok(serverProcess);
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not exit after stdin EOF")), 3000);
      serverProcess.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    serverProcess.stdin.end();
    assert.deepEqual(await exited, { code: 0, signal: null });

    const childDeadline = Date.now() + 3000;
    let childAlive = true;
    while (Date.now() < childDeadline) {
      try {
        process.kill(sshPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
        childAlive = false;
        break;
      }
    }
    assert.equal(childAlive, false, `PTY child ${sshPid} should exit with its server`);
  } finally {
    await client.close();
  }
});

test("login menu errors, secrets and host mismatch are handled without format assumptions", { timeout: 15000 }, async (t) => {
  if (process.platform === "win32") return t.skip("requires a Unix PTY and shell");

  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-login-"));
  const binDir = join(tempDir, "bin");
  const pidFile = join(tempDir, "ssh.pid");
  await mkdir(binDir);
  const fakeSsh = join(binDir, "ssh");
  await writeFile(fakeSsh, FAKE_SSH_SCRIPT);
  await chmod(fakeSsh, 0o755);
  const configPath = join(tempDir, "mcp-jumpserver.yaml");
  await writeFile(
    configPath,
    [
      "jumpserver:",
      "  sshTarget: local-test",
      "  auth:",
      "    method: ssh_key",
      "assets:",
      "  allowed:",
      "    - asset-name",
      "expect:",
      "  menu_timeout: 5",
      "  shell_timeout: 2",
      "  close_timeout: 1",
      "  quiet_period_ms: 100",
      "",
    ].join("\n"),
  );
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      MCP_JUMPSERVER_CONFIG: configPath,
      SSH_TEST_PIDFILE: pidFile,
      SSH_TEST_PS1: "other-host$ ",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "login-test", version: "0.0.0" });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    const { session_id: sessionId } = await call("connect", { asset: "asset-name" });

    const notReady = await call("confirm_shell", { session_id: sessionId });
    assert.equal(notReady.ready, false, JSON.stringify(notReady));
    assert.equal(notReady.session_state, "interactive");
    assert.match(notReady.output, /no such host/);

    const secret = await call("send_input", { session_id: sessionId, input: "s3cret-Passw0rd" });
    assert.match(secret.output, /no such host/);

    await call("send_input", { session_id: sessionId, input: "asset-name" });
    const ready = await call("confirm_shell", { session_id: sessionId });
    assert.equal(ready.ready, true, JSON.stringify(ready));
    assert.equal(ready.prompt_line, "other-host$");
    if (!hostname().toLowerCase().includes("asset-name")) {
      assert.match(ready.warning, /Declared asset "asset-name"/);
    }

    const wide = await call("execute", { session_id: sessionId, command: "echo " + "x".repeat(300) });
    assert.equal(wide.stdout, "x".repeat(300));

    await call("close", { session_id: sessionId });
    assert.match(stderr, /"msg":"send_input"[^\n]*"inputLength":15/);
    assert.equal(stderr.includes("s3cret-Passw0rd"), false);
  } finally {
    await client.close();
  }
});

test("SIGKILL of the MCP server closes its PTY SSH child", { timeout: 10000 }, async (t) => {
  if (process.platform === "win32") return t.skip("requires a Unix PTY and shell");

  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-sigkill-"));
  const binDir = join(tempDir, "bin");
  const pidFile = join(tempDir, "ssh.pid");
  await mkdir(binDir);
  const fakeSsh = join(binDir, "ssh");
  await writeFile(fakeSsh, FAKE_SSH_SCRIPT);
  await chmod(fakeSsh, 0o755);
  const configPath = join(tempDir, "mcp-jumpserver.yaml");
  await writeFile(
    configPath,
    [
      "jumpserver:",
      "  sshTarget: local-test",
      "  auth:",
      "    method: ssh_key",
      "assets:",
      "  allowed:",
      "    - asset-name",
      "expect:",
      "  menu_timeout: 5",
      "  shell_timeout: 5",
      "  close_timeout: 1",
      "  quiet_period_ms: 100",
      "",
    ].join("\n"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      MCP_JUMPSERVER_CONFIG: configPath,
      SSH_TEST_PIDFILE: pidFile,
      SSH_TEST_PS1: "asset-name# ",
    },
  });
  const client = new Client({ name: "sigkill-test", version: "0.0.0" });
  let sshPid;
  let sshExited = false;
  try {
    await client.connect(transport);
    const connected = await client.callTool({ name: "connect", arguments: { asset: "asset-name" } });
    assert.equal(connected.isError, undefined, connected.content?.[0]?.text);
    sshPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(Number.isInteger(sshPid) && sshPid > 0);

    const serverProcess = transport._process;
    assert.ok(serverProcess);
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not exit after SIGKILL")), 3000);
      serverProcess.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    serverProcess.kill("SIGKILL");
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });

    const childDeadline = Date.now() + 3000;
    let childAlive = true;
    while (Date.now() < childDeadline) {
      try {
        process.kill(sshPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
        childAlive = false;
        sshExited = true;
        break;
      }
    }
    assert.equal(childAlive, false, `PTY child ${sshPid} should exit with its server`);
  } finally {
    if (sshPid && !sshExited) {
      try { process.kill(sshPid, "SIGKILL"); } catch {}
    }
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stdio connect reports ssh_not_found when the server PATH lacks ssh", { timeout: 15000 }, async (t) => {
  if (process.platform === "win32") return t.skip("requires a Unix PATH layout");

  const tempDir = await mkdtemp(join(tmpdir(), "jumpserver-mcp-nossh-stdio-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "mcp-jumpserver.yaml");
  await writeFile(
    configPath,
    [
      "jumpserver:",
      "  sshTarget: local-test",
      "  auth:",
      "    method: ssh_key",
      "assets:",
      "  allowed:",
      "    - asset-name",
      "",
    ].join("\n"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      PATH: tempDir,
      MCP_JUMPSERVER_CONFIG: configPath,
    },
  });
  const client = new Client({ name: "nossh-stdio-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "connect", arguments: { asset: "asset-name" } });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error, "ssh_not_found");
    assert.match(payload.message, /ssh executable not found in PATH/);
  } finally {
    await client.close();
  }
});
