import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_OUTPUT_LIMIT_BYTES } from "../config.js";
import { SessionError } from "../errors.js";
import { logger } from "../logger.js";
import type { SessionManager } from "../session/manager.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function callTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof SessionError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.code, message: err.message }, null, 2) }],
        isError: true,
      };
    }
    logger.error("tool failed", { err: String(err) });
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "runner_error", message: String(err) }, null, 2) }],
      isError: true,
    };
  }
}

export function registerTools(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    "connect",
    {
      title: "Connect to JumpServer asset",
      description:
        'Open an SSH session to JumpServer for the given asset. The server does not navigate the login menu: this returns status "interactive" and the current terminal text in "output". Read it, then use send_input step by step (search, pick the asset, pick an account, enter credentials) until the target host\'s shell prompt appears, and call confirm_shell. You must enter the asset you declared here. Sessions are reused per asset; a reused session already in "connected" state can be used with execute directly. Never auto-reconnects.',
      inputSchema: {
        asset: z.string().describe("Asset name as shown in JumpServer, e.g. fe1"),
      },
    },
    async ({ asset }) => callTool(() => manager.connect(asset)),
  );

  server.registerTool(
    "send_input",
    {
      title: "Send input during login",
      description:
        'Send raw input to a session in "interactive" state and return the terminal text produced since the last returned text. Use an empty input with enter=false to only read new output. Output end is detected by a quiet period, so slow screens may arrive in a later call. Flow: connect, then send_input until the target host\'s shell prompt is visible, then confirm_shell, then execute. You must enter the asset declared in connect. Control characters can be sent in the input string (for example "\\u0003" for Ctrl+C) with enter=false. Only available while the session is "interactive"; do not use it to run shell commands.',
      inputSchema: {
        session_id: z.string().describe("Session id from connect"),
        input: z.string().describe("Raw text written to the terminal; may be empty"),
        enter: z.boolean().optional().describe("Append Enter after the input (default true)"),
        wait: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("Max seconds to wait for output to go quiet (default expect.input_timeout)"),
      },
    },
    async ({ session_id, input, enter, wait }) => callTool(() => manager.sendInput(session_id, input, enter, wait)),
  );

  server.registerTool(
    "confirm_shell",
    {
      title: "Confirm target shell",
      description:
        'Call once the target host\'s shell prompt is visible. The server verifies the shell with a marker command. On success the session becomes "connected" and execute can be used; the result includes hostname and prompt_line, plus a warning when neither contains the declared asset name — in that case confirm with the user before executing commands. On failure ready=false is returned with the current terminal text and the session stays "interactive". This types a one-line printf command followed by Enter into the terminal, so never call it at a password or MFA prompt or while still in a menu: with ready=false that line has already been consumed as input by whatever screen was showing.',
      inputSchema: {
        session_id: z.string().describe("Session id from connect"),
      },
    },
    async ({ session_id }) => callTool(() => manager.confirmShell(session_id)),
  );

  server.registerTool(
    "execute",
    {
      title: "Execute shell command in session",
      description:
        "Execute a shell command in an existing session. Requires a session_id from connect whose login has been completed with confirm_shell (status \"connected\"). Commands run serially per session: if a previous command is still running this returns session_busy. Shell state (cwd, env vars) carries over between commands. Command failure does not imply session loss. On timeout the session stays busy; use cancel to interrupt it, or wait for natural completion before executing another command.",
      inputSchema: {
        session_id: z.string().describe("Session id from connect"),
        command: z.string().describe("Shell command to execute"),
        timeout: z.number().int().positive().optional().describe("Timeout seconds for this command"),
        output_limit: z
          .number()
          .int()
          .positive()
          .max(MAX_OUTPUT_LIMIT_BYTES)
          .optional()
          .describe("Max output bytes before truncation (up to 1 MiB)"),
      },
    },
    async ({ session_id, command, timeout, output_limit }) =>
      callTool(() => manager.execute(session_id, command, timeout, output_limit)),
  );

  server.registerTool(
    "cancel",
    {
      title: "Cancel running command",
      description:
        "Interrupt the currently running command in a busy session by sending Ctrl+C. Success is determined by a marker command completing after the interrupt. The target process may ignore SIGINT; the result reports cancelled=false in that case. Only affects the current command, not the session.",
      inputSchema: {
        session_id: z.string().describe("Session id from connect"),
      },
    },
    async ({ session_id }) => callTool(() => manager.cancel(session_id)),
  );

  server.registerTool(
    "get_session",
    {
      title: "Get session status",
      description: "Query the current state of one session by id.",
      inputSchema: {
        session_id: z.string().describe("Session id from connect"),
      },
    },
    async ({ session_id }) => callTool(() => Promise.resolve(manager.getSession(session_id))),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description: "List all sessions visible to the current client.",
      inputSchema: {},
    },
    async () => callTool(() => Promise.resolve(manager.listSessions())),
  );

  server.registerTool(
    "close",
    {
      title: "Close session",
      description:
        "Explicitly close a session: exits the target shell and terminates the SSH connection to JumpServer. Sessions idle beyond the configured idle timeout are reaped automatically.",
      inputSchema: {
        session_id: z.string().describe("Session id from connect"),
      },
    },
    async ({ session_id }) => callTool(() => manager.close(session_id).then(() => ({ session_id, status: "closed" }))),
  );
}
