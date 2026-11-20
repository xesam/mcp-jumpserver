# mcp-jumpserver

English | [简体中文](README.md)

A Model Context Protocol (MCP) server that gives AI agents persistent shell sessions to servers accessed through JumpServer. It uses an interactive SSH connection and keeps the session open across commands, so shell state such as the working directory and environment variables is preserved.

All remote access goes through JumpServer, including its authentication, authorization, and audit controls.

## Features

- Connects to JumpServer / KoKo using OpenSSH and a PTY; the login interaction is driven by the agent on the MCP client side
- Persistent shell sessions with explicit `connect`, `send_input`, `confirm_shell`, `execute`, and `close` operations
- Session reuse by MCP client and asset, including sessions whose login has not finished yet
- Serialized commands within a session and parallel operation across sessions
- Explicit handling for interactive, busy, timed-out, cancelled, and disconnected sessions
- Checks that the asset name declared in `connect` is in the allowlist, and checks session ownership
- Structured logs written to stderr, leaving the stdio MCP transport available for protocol messages; input text and terminal text are never logged

## Requirements

- Node.js 20 or later
- OpenSSH client
- `node-pty` ships prebuilt binaries for mainstream platforms, so local compilation is normally unnecessary; the build toolchain is only needed when no prebuilt binary matches the platform (Xcode Command Line Tools on macOS, Visual Studio C++ build tools on Windows, or python3 with make and g++ on Linux)
- Access to a JumpServer SSH endpoint and authorization for the target assets
- SSH key authentication, with the key specified in `~/.ssh/config` or by `jumpserver.auth.key_path` in the configuration file

### Limitations

- The target host's shell must be POSIX-compatible (`execute` relies on `eval`, `printf`, and `$?`); non-POSIX shells (fish, csh) and network device CLIs are not supported.
- The allowlist constrains only the asset name passed to `connect` (which is also the session-reuse key), not the host the agent actually logs into: every host reachable by the bastion account is reachable. The host the agent actually logs into can only be checked against the `hostname` and `prompt_line` returned by `confirm_shell`, with an optional `warning` field when they look inconsistent. The warning is informational, not an enforced check. Access control must be enforced in JumpServer.
- While a session is `interactive`, `send_input` writes arbitrary text to the terminal. Once the agent has reached any host's shell, it can run commands through `send_input` without calling `confirm_shell`; in that case there is no host-mismatch `warning`, and client-side approval configured only for `execute` does not apply.
- `close` sends `exit` in a confirmed shell and then terminates the local `ssh` process to disconnect from the bastion host; it does not send an exit command to the JumpServer menu.

## Installation

The package is published to npm; an MCP host starts it with `npx`, with no install or build required:

```bash
npx -y mcp-jumpserver
```

This command starts the stdio MCP server directly and is normally not run by hand — see "MCP Host Setup" for how to configure it in a host. On first run npm downloads the package (`node-pty` ships prebuilt binaries for mainstream platforms, so local compilation is normally unnecessary). You can also install globally and then use the `mcp-jumpserver` command:

```bash
npm install -g mcp-jumpserver
```

Build from source (for developing this server):

```bash
git clone https://github.com/xesam/mcp-jumpserver.git
cd mcp-jumpserver
npm install
npm run build
```

The build output is in `dist/`, with `dist/index.js` as the entry point.

### Troubleshooting

The error codes returned by a failed `connect` carry direct clues for two environment problems:

- `ssh_not_found`: no `ssh` executable was found in the `PATH` of the MCP server process. The error message includes the current `PATH`. Install the OpenSSH client, or fix `PATH` in the environment that launches the MCP host.
- `pty_spawn_failed`: node-pty could not spawn the `ssh` process. On macOS the most common cause is node-pty's `spawn-helper` binary missing the executable bit (the error resembles `posix_spawn failed: Permission denied`). Since 0.0.2 a postinstall script restores the bit automatically; in environments that disable lifecycle scripts, run `chmod +x <spawn-helper path>` manually using the path from the error message.

## Configuration

Copy the example configuration and edit it for your environment. See [`mcp-jumpserver.example.yaml`](mcp-jumpserver.example.yaml) for all fields and defaults; the file ships with the npm package and is also available in [the repository](https://github.com/xesam/mcp-jumpserver/blob/main/mcp-jumpserver.example.yaml):

```bash
# Without a local clone, download from GitHub
curl -o mcp-jumpserver.yaml https://raw.githubusercontent.com/xesam/mcp-jumpserver/main/mcp-jumpserver.example.yaml

# With a clone of the repository, or a local install of the package, copy the file
cp mcp-jumpserver.example.yaml mcp-jumpserver.yaml
cp node_modules/mcp-jumpserver/mcp-jumpserver.example.yaml mcp-jumpserver.yaml
```

The configuration file path is taken from the `MCP_JUMPSERVER_CONFIG` environment variable. If it is not set, the server reads `mcp-jumpserver.yaml` from the process working directory. This file holds real environment details, and the repository's `.gitignore` does not exclude it, so take care not to commit it.

There are two ways to specify the JumpServer connection; provide at least one:

```yaml
# Option 1: a Host alias from ~/.ssh/config; host, port, user, and key come from the SSH configuration
jumpserver:
  sshTarget: jumpserver
  auth:
    method: ssh_key
```

```yaml
# Option 2: explicit connection parameters
jumpserver:
  host: jumpserver.example.com
  port: 2222                 # default 22
  username: your-name
  auth:
    method: ssh_key
    key_path: ~/.ssh/id_ed25519
```

When `sshTarget` is set, `host`, `port`, `username`, and `auth.key_path` are ignored.

Other fields:

| Field | Default | Description |
|---|---|---|
| `assets.allowed` | required | Asset names that may be connected to; the `asset` argument of `connect` must match one of them exactly |
| `ssh.connect_timeout` | 30 | SSH connection timeout in seconds |
| `ssh.keepalive_interval` | 30 | SSH keepalive interval in seconds |
| `session.idle_timeout` | 600 | Local idle-session cleanup limit in seconds |
| `session.max_sessions` | 3 | Maximum number of concurrent sessions |
| `session.command_timeout` | 60 | Default command timeout in seconds; can be overridden per `execute` call |
| `session.output_limit` | 65536 | Maximum command output in bytes, up to 1 MiB; can be overridden per `execute` call |
| `expect.menu_timeout` | 30 | Time limit in seconds for `connect` to wait for the first screen of output |
| `expect.shell_timeout` | 30 | Time limit in seconds for `confirm_shell` to wait for its probe marker |
| `expect.close_timeout` | 10 | Time limit in seconds for `cancel` to wait for its probe marker and for `close` to wait for the target shell to exit |
| `expect.quiet_period_ms` | 1000 | Quiet period in milliseconds used to decide that terminal output has stopped |
| `expect.input_timeout` | 10 | Default time limit in seconds for `send_input` to wait for output to stop; can be overridden per call |

`session.idle_timeout` only controls local cleanup; the server does not detect the server-side idle timeout. Set it according to the shortest server-side idle timeout in your environment.

## MCP Host Setup

Configure this server in your MCP host as a local stdio server and set `MCP_JUMPSERVER_CONFIG` to the absolute path of your configuration file. Example for the npm package:

```json
{
  "mcpServers": {
    "mcp-jumpserver": {
      "command": "npx",
      "args": ["-y", "mcp-jumpserver"],
      "env": {
        "MCP_JUMPSERVER_CONFIG": "/absolute/path/to/mcp-jumpserver.yaml"
      }
    }
  }
}
```

To pin a version, write `mcp-jumpserver@<version>` in `args` instead of `mcp-jumpserver`. With a global install, `command` can be `mcp-jumpserver` directly; for a source build, use `"command": "node"` with `args` set to `["/absolute/path/to/mcp-jumpserver/dist/index.js"]`.

Host configuration formats vary. The repository's [example project](example/README.md) (in Chinese) provides working configurations for Claude Code, OpenCode, and Codex, along with step-by-step verification.

## Tools

The server provides the following 8 tools. After `connect` returns, the session is in the `interactive` state and `execute` cannot be called directly — the steps in "Connection flow" below must be completed first.

| Tool | Purpose |
|---|---|
| `connect` | Open or reuse a session, returning its `session_id` and the terminal text from the first login screen |
| `send_input` | Send input to the terminal during login, returning the terminal text produced since the last call |
| `confirm_shell` | Confirm that the target host's shell has been reached, making the session executable |
| `execute` | Run a command in a ready session |
| `cancel` | Interrupt a running command |
| `get_session` | Query a session's state |
| `list_sessions` | List sessions belonging to the current MCP client |
| `close` | Close a session and release its resources |

### Connection flow

The login interaction is driven by the caller (the agent on the MCP client side); the server does not parse any menu or shell prompt format:

1. Call `connect(asset)`. It returns `session_id`, `status: "interactive"`, and `output` (the terminal text from the first login screen). Calling it again for the same asset reuses the existing session: reusing an `interactive` session also returns its current `output`; reusing a `connected` / `busy` session returns no `output`, and `execute` can be called directly without repeating the connection flow.
2. Read `output` and call `send_input(session_id, input, enter?, wait?)` step by step (searching for the asset, picking it from a list, picking an account, entering a password or MFA code, and so on). `input` is written to the terminal as-is; `enter` appends Enter by default. Each call returns the terminal text produced since the last call; output can arrive in parts, and a single call may return only part of it, with the rest returned by a later call. To only read new output without sending anything, pass an empty `input` with `enter: false`.
3. Once `output` shows that the target host's shell has been reached, call `confirm_shell(session_id)`. `confirm_shell` types a one-line `printf` command followed by Enter into the terminal, so never call it at a password or MFA prompt or while still in a menu; otherwise that line is handled as input by whatever screen is showing.
4. On success it returns `ready: true`, the session becomes `connected`, and `execute` can be used. The result also includes `hostname` and `prompt_line`, plus a `warning` field when neither contains the declared asset name — this means the session may be on a different host and should be confirmed with the user before executing commands; it is only a hint and does not prevent the session from becoming `connected`. On failure it returns `ready: false` with the terminal text produced since the probe, and this is not an error: the session stays `interactive`. The probe command has by then been handled as input by whatever screen was showing, so `send_input` can continue from there.

Example (JSON-RPC envelope omitted; only arguments and results are shown):

```jsonc
// 1. Open the connection
connect({ "asset": "web-01" })
// => { "session_id": "sess_...", "asset": "web-01", "status": "interactive", "reused": false, "output": "Select host:" }

// 2. Enter the asset name
send_input({ "session_id": "sess_...", "input": "web-01" })
// => { "session_id": "sess_...", "output": "Last login: ...\n[root@web-01 ~]#", "truncated": false, "session_state": "interactive" }

// 3. Confirm the target shell
confirm_shell({ "session_id": "sess_..." })
// => { "session_id": "sess_...", "ready": true, "session_state": "connected", "hostname": "web-01", "prompt_line": "[root@web-01 ~]#" }

// 4. Run a command
execute({ "session_id": "sess_...", "command": "pwd" })
// => { "session_id": "sess_...", "exit_code": 0, "stdout": "/root", "duration_ms": 12, "truncated": false, "session_state": "connected" }
```

Behavior:

- The connection flow must be completed before executing commands. Calling `execute` or `cancel` while `interactive` returns the error code `session_not_ready`; `send_input` and `confirm_shell` are only available while `interactive`, returning `session_not_interactive` otherwise.
- If the `ssh` process exits between calls during login (for example, the bastion host disconnects after a failed MFA check), the session becomes `disconnected`. If there is terminal text that has not been returned yet, the next `send_input` writes nothing and returns only that text, with `session_state` set to `disconnected`; later `send_input` and `confirm_shell` calls return `session_disconnected`.
- `execute` does not reconnect automatically. After a disconnection, call `connect` again explicitly.
- Commands within a session, including login steps, run serially. While a session is busy, a new `execute` is rejected with `session_busy` rather than queued; wait and retry, or check the state with `get_session`.
- A command timeout does not stop the remote command, and the session stays busy. Call `cancel` to interrupt it, or wait for it to finish.
- `cancel` sends Ctrl+C and then confirms the command ended using a probe marker. The remote process may ignore the signal and consume the probe command itself, in which case the result has `cancelled` set to `false`.
- Commands run in a pseudo-terminal, so the `stdout` field returned by `execute` contains both standard output and standard error, and the two cannot be told apart.
- Output beyond `output_limit` is truncated, and the result has `truncated` set to `true`.

## Development

```bash
npm run check
npm run check:scripts
npm test
node scripts/smoke.mjs
```

The end-to-end test requires a reachable JumpServer and a permitted asset:

```bash
MCP_JUMPSERVER_CONFIG=/path/to/mcp-jumpserver.yaml \
JUMPSERVER_MCP_TEST_ASSET=asset-name \
node scripts/e2e.mjs
```

If logging into that asset needs more steps than just the asset name (for example picking from a list or choosing an account), provide the further inputs with `JUMPSERVER_MCP_TEST_LOGIN_INPUTS`, comma-separated:

```bash
JUMPSERVER_MCP_TEST_LOGIN_INPUTS=1,1 node scripts/e2e.mjs
```

Two of its checks depend on a real bastion-host environment and cannot be verified by the unit or smoke tests: `300-column echo is parsed` verifies that the bastion host forwards terminal window-size changes to the target host (`confirm_shell` widens the terminal from 200 columns to 2048 before sending its probe command, to keep long command echoes from wrapping, and reverts to 200 columns if the probe fails); the `cancel` checks verify that the probe command still works after Ctrl+C is forwarded through the bastion host.

## Security

This server provides remote shell access. Apply least-privilege access controls in JumpServer and restrict the configured asset allowlist. The allowlist only checks the asset name declared in `connect`; every host reachable by the bastion account can be reached through `send_input`, so access control must be enforced in JumpServer. While a session is `interactive`, `send_input` can write arbitrary text to the terminal, including shell commands; require the same approval level for `send_input` as for `execute` in the MCP client. Keep configuration files and SSH credentials out of source control. Credentials are not written to application logs: `send_input`'s input text and any terminal text are never logged; only the session id, state changes, and input length are recorded.
