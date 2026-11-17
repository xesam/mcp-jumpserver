# MCP Client 示例项目

本目录提供 Claude Code、OpenCode 和 Codex 的项目级 MCP 配置，用于在本仓库内直接运行并验证 `mcp-jumpserver`。三份配置都以 stdio 方式启动仓库构建出的 `../dist/index.js`，并读取本目录下的 `mcp-jumpserver.yaml`。

服务器的配置字段和工具行为约定见[根目录 README](../README.md)，本文只说明示例的运行和验证步骤。

## 1. 构建

在仓库根目录执行：

```bash
npm install
npm run build
```

## 2. 准备配置

本目录已提供一份 `mcp-jumpserver.yaml`，三份客户端配置都读取它。其中的资产名是可公开的示例值，需要换成自己环境的值；SSH 认证方式（例如 `IdentityFile`）在 `~/.ssh/config` 对应的 Host 中配置。编辑该文件，至少修改两项：

- `jumpserver.sshTarget`：改为 `~/.ssh/config` 中已配置好 SSH 密钥认证的 Host 别名
- `assets.allowed`：改为 JumpServer 中已授权给当前账号的资产名称

该文件受 Git 跟踪，改成真实值后会出现在 `git status` 中，不要把这些改动提交到版本控制。字段说明见根目录 README 的[配置](../README.md#配置)一节。

## 3. 启动客户端

从本目录启动客户端。配置中的 `../dist/index.js` 和 `mcp-jumpserver.yaml` 都是相对路径，按客户端启动时的工作目录解析，从其他目录启动会加载失败。

| 客户端 | 配置文件 | 启动命令 | 检查配置是否加载 |
|---|---|---|---|
| Claude Code | `.mcp.json` | `claude` | 会话中运行 `/mcp` |
| OpenCode | `opencode.json` | `opencode` | 另开终端运行 `opencode mcp list` |
| Codex | `.codex/config.toml` | `codex` | 另开终端运行 `codex mcp list`，或在会话中运行 `/mcp` |

首次使用时的注意事项：

- Claude Code 会要求审核并批准 `.mcp.json` 中的服务器，批准后才会加载。
- Codex 只从 `.codex/config.toml` 读取项目级 MCP 配置，并且仅对受信任的项目生效。首次在本仓库启动时，按提示选择信任该项目。

## 4. 验证

上一步的检查命令只说明客户端读取到了配置，不代表服务进程已经启动成功。按下面两步验证工具调用。

### 4.1 验证 MCP 通道

在客户端对话中要求它调用 `mcp-jumpserver` 的 `list_sessions` 工具。预期结果：

```json
{"sessions": []}
```

这一步不会连接 JumpServer。

### 4.2 连接资产并执行命令

在客户端对话中发送以下请求，把占位文本替换为 `assets.allowed` 中的资产名称：

```text
请按顺序直接调用 mcp-jumpserver 工具，完成一次登录并执行命令：
1. 调用 connect，asset 使用 <authorized-asset-name>，记下返回的 session_id，阅读其中的 output。
2. 根据 output 中的终端文本，用 send_input 逐步完成登录交互（输入资产名、按提示选择列表或账号等），
   每次调用后重新阅读返回的 output，直到看到目标主机的 Shell 提示符。
3. 调用 confirm_shell。如果 ready 为 true，继续下一步；如果为 false，根据返回的 output 继续用 send_input 操作后重试。
4. 调用 execute，执行只读命令 `printf mcp-ok`。
5. 调用 get_session 查询该 session_id 的状态。
6. 最后调用 close 关闭该 session_id。
请报告每一步的工具结果，不要改用其他连接方式。
```

预期结果：

- `connect` 返回 `session_id`，`status` 为 `interactive`
- `confirm_shell` 返回 `ready: true`，`session_state` 为 `connected`
- `execute` 返回 `exit_code: 0`，`stdout` 为 `mcp-ok`
- `get_session` 显示状态为 `connected`
- `close` 返回 `status: closed`

测试结束后调用 `close` 释放 SSH 会话。未手动关闭的会话会在 `session.idle_timeout` 之后被清理。

## 故障排查

通用问题：

- **客户端中找不到 `mcp-jumpserver` 或其工具**：确认是从本目录启动的客户端，并且已经执行过 `npm run build`（`../dist/index.js` 存在）。
- **服务启动失败**：检查 Node.js 版本是否为 20 或更高，以及依赖是否已安装。服务日志写入 stderr，可在客户端的 MCP 日志中查看。
- **报配置文件不可读**：确认是从本目录启动的客户端，并且本目录下的 `mcp-jumpserver.yaml` 存在。
- **`connect` 返回 `asset_not_allowed`**：`asset` 参数必须与 `assets.allowed` 中的名称完全一致。
- **`connect` 返回 `connect_failed`**：可能是在 `expect.menu_timeout` 内没有收到任何输出，也可能是 `ssh` 进程在建立连接期间就已退出（例如认证被拒绝）；具体原因见返回值中的 `message` 字段。先在终端中手动执行 `ssh <sshTarget>`，确认能登录 JumpServer。
- **`confirm_shell` 一直返回 `ready: false`**：说明探测命令发出后在 `expect.shell_timeout` 内没有匹配到探测标记，通常是还没有真正进入目标主机的 Shell。根据返回的 `output` 判断当前所在界面，用 `send_input` 继续操作后再调用 `confirm_shell`；也可参考根目录 README 的[限制](../README.md#限制)。
- **`execute` 或 `cancel` 返回 `session_not_ready`**：会话仍处于 `interactive` 状态，登录尚未完成，需要先完成 `send_input` → `confirm_shell` 的步骤。

客户端专属问题：

- **Codex 中看不到 `mcp-jumpserver`**：确认项目已被信任，并用 `codex mcp list` 检查配置是否被读取。
- **Codex 非交互模式（`codex exec`）报 `MCP tool call requires approval`**：该模式无法弹出审批提示，可在命令中加上 `-c 'mcp_servers.mcp-jumpserver.default_tools_approval_mode="approve"'` 预先批准。
