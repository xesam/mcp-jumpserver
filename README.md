# mcp-jumpserver

[English](README.en.md) | 简体中文

一个模型上下文协议（MCP）服务器，为 AI Agent 提供通过 JumpServer 访问服务器的持久 Shell 会话。它通过交互式 SSH 连接保持会话，使工作目录、环境变量等 Shell 状态能够在多次命令间延续。

所有远程访问均经由 JumpServer，并遵循其认证、授权和审计控制。

## 功能特性

- 使用 OpenSSH 和 PTY 连接 JumpServer / KoKo，登录交互由 MCP Client 侧的 agent 驱动
- 提供持久 Shell 会话及显式的 `connect`、`send_input`、`confirm_shell`、`execute`、`close` 生命周期
- 按 MCP Client 和资产复用会话，包括登录尚未完成的会话
- 同一会话内串行执行命令，不同会话间可并行
- 明确处理交互中、忙碌、超时、取消和断开状态
- 校验 `connect` 声明的资产名是否在白名单内，并校验会话归属
- 结构化日志写入 stderr，不占用 stdio MCP 协议通道；输入内容和终端文本不写入日志

## 环境要求

- Node.js 20 或更高版本
- OpenSSH 客户端
- 首次安装时编译原生模块 `node-pty` 所需的工具链：macOS 为 Xcode Command Line Tools，Windows 为 Visual Studio 的 C++ 构建工具，Linux 为 python3 与 make、g++
- 可访问 JumpServer SSH 接入端点，并已获准访问目标资产
- 使用 SSH 密钥认证，通过 `~/.ssh/config` 或配置文件中的 `jumpserver.auth.key_path` 指定密钥

### 限制

- 目标主机的 Shell 需兼容 POSIX（`execute` 依赖 `eval`、`printf`、`$?`），不支持 fish、csh 等非 POSIX Shell 或网络设备 CLI。
- 白名单只约束 `connect` 传入的资产名（同时作为会话复用的键），不约束 agent 实际登录的主机：堡垒机账号可访问的所有主机都可以到达。agent 实际登录到的主机只能在 `confirm_shell` 返回的 `hostname`、`prompt_line` 中核对，必要时附带 `warning` 字段提示可能不一致，提示不等于强制校验。访问控制必须在 JumpServer 中实施。
- 会话处于 `interactive` 状态时，`send_input` 向终端写入任意文本。agent 一旦进入任一主机的 Shell，就可以不调用 `confirm_shell`、直接通过 `send_input` 执行命令；此时不会产生主机不一致的 `warning`，MCP Client 中只针对 `execute` 配置的审批也不会生效。
- `close` 在已确认的 Shell 中发送 `exit`，随后终止本地的 `ssh` 进程，断开与堡垒机的连接；不向 JumpServer 菜单发送退出命令。

## 安装

包已发布到 npm，由 MCP Host 通过 `npx` 启动，无需安装或构建：

```bash
npx -y mcp-jumpserver
```

该命令直接启动 stdio MCP 服务器，通常不在命令行手动运行，而是在 MCP Host 中配置，见「MCP Host 接入」。首次运行时 npm 会下载包并编译原生模块。也可以全局安装，之后直接使用 `mcp-jumpserver` 命令：

```bash
npm install -g mcp-jumpserver
```

从源码构建（用于开发本服务器）：

```bash
git clone https://github.com/xesam/mcp-jumpserver.git
cd mcp-jumpserver
npm install
npm run build
```

构建产物位于 `dist/`，入口为 `dist/index.js`。

## 配置

复制示例配置并按环境修改。完整的字段和默认值见 [`mcp-jumpserver.example.yaml`](mcp-jumpserver.example.yaml)，该文件随 npm 包分发，也可从[仓库](https://github.com/xesam/mcp-jumpserver/blob/main/mcp-jumpserver.example.yaml)获取：

```bash
# 未克隆仓库时，从 GitHub 下载
curl -o mcp-jumpserver.yaml https://raw.githubusercontent.com/xesam/mcp-jumpserver/main/mcp-jumpserver.example.yaml

# 克隆了仓库，或本地安装过包时，直接复制
cp mcp-jumpserver.example.yaml mcp-jumpserver.yaml
cp node_modules/mcp-jumpserver/mcp-jumpserver.example.yaml mcp-jumpserver.yaml
```

配置文件路径由环境变量 `MCP_JUMPSERVER_CONFIG` 指定，未设置时读取进程工作目录下的 `mcp-jumpserver.yaml`。该文件含真实环境信息，仓库的 `.gitignore` 没有排除它，注意不要提交到版本控制。

连接 JumpServer 有两种写法，至少提供一种：

```yaml
# 写法一：使用 ~/.ssh/config 中的 Host 别名，主机、端口、用户和密钥都由 SSH 配置决定
jumpserver:
  sshTarget: jumpserver
  auth:
    method: ssh_key
```

```yaml
# 写法二：直接指定连接参数
jumpserver:
  host: jumpserver.example.com
  port: 2222                 # 默认 22
  username: your-name
  auth:
    method: ssh_key
    key_path: ~/.ssh/id_ed25519
```

设置了 `sshTarget` 时，`host`、`port`、`username` 和 `auth.key_path` 不生效。

其余字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `assets.allowed` | 必填 | 允许连接的资产名称列表，`connect` 的 `asset` 参数必须与其中一项完全一致 |
| `ssh.connect_timeout` | 30 | SSH 连接超时，单位秒 |
| `ssh.keepalive_interval` | 30 | SSH 保活间隔，单位秒 |
| `session.idle_timeout` | 600 | 本地空闲会话清理时限，单位秒 |
| `session.max_sessions` | 3 | 同时存在的会话数上限 |
| `session.command_timeout` | 60 | 命令默认超时，单位秒，可在 `execute` 中按次覆盖 |
| `session.output_limit` | 65536 | 命令输出字节数上限，最大 1 MiB，可在 `execute` 中按次覆盖 |
| `expect.menu_timeout` | 30 | `connect` 等待首屏输出的时限，单位秒 |
| `expect.shell_timeout` | 30 | `confirm_shell` 等待探测标记的时限，单位秒 |
| `expect.close_timeout` | 10 | `cancel` 等待探测标记、`close` 等待目标 Shell 退出的时限，单位秒 |
| `expect.quiet_period_ms` | 1000 | 判定终端输出已停止的静默时长，单位毫秒 |
| `expect.input_timeout` | 10 | `send_input` 等待输出停止的默认时限，单位秒，可在调用中按次覆盖 |

`session.idle_timeout` 只控制本地清理，服务器不会探测服务端的空闲超时。请按所在环境中最短的服务端空闲超时来设置。

## MCP Host 接入

在 MCP Host 中把本服务器配置为本地 stdio Server，并将 `MCP_JUMPSERVER_CONFIG` 设为配置文件的绝对路径。通过 npm 包使用时的配置示例：

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

需要固定版本时，把 `args` 中的 `mcp-jumpserver` 写成 `mcp-jumpserver@<版本号>`。已全局安装时，`command` 可直接写 `mcp-jumpserver`；从源码构建时，写 `"command": "node"`，`args` 写 `["/absolute/path/to/mcp-jumpserver/dist/index.js"]`。

不同 Host 的配置格式不同。仓库的[示例项目](example/README.md)提供了 Claude Code、OpenCode 和 Codex 的可运行配置，以及逐步验证的方法。

## 工具

服务器提供以下 8 个工具。`connect` 返回后会话状态为 `interactive`，不能直接调用 `execute`，必须先完成下面「连接流程」中的步骤。

| 工具 | 用途 |
|---|---|
| `connect` | 建立或复用会话，返回 `session_id` 和登录首屏的终端文本 |
| `send_input` | 在登录过程中向终端发送输入，返回自上次调用以来新增的终端文本 |
| `confirm_shell` | 确认已到达目标主机的 Shell，使会话变为可执行状态 |
| `execute` | 在已就绪的会话中执行命令 |
| `cancel` | 中断正在运行的命令 |
| `get_session` | 查询会话状态 |
| `list_sessions` | 列出当前 MCP Client 的会话 |
| `close` | 关闭会话并释放资源 |

### 连接流程

登录过程由调用方（MCP Client 侧的 agent）驱动，服务端不解析菜单或 Shell 提示符格式：

1. 调用 `connect(asset)`，返回 `session_id`、`status: "interactive"` 和 `output`（登录首屏的终端文本）。对同一资产重复调用会复用已有会话：复用到 `interactive` 会话时同样返回当前的 `output`；复用到 `connected` / `busy` 会话时不返回 `output`，此时可直接调用 `execute`，无需重复连接流程。
2. 阅读 `output`，调用 `send_input(session_id, input, enter?, wait?)` 逐步操作（搜索资产、从列表中选择、选择账号、输入口令或 MFA 等）。`input` 原样写入终端，`enter` 默认追加回车。每次调用返回自上次调用以来新增的终端文本；输出可能分多次到达，单次调用也可能只收到部分输出，其余部分由后续调用返回。要只读取新输出而不输入内容，可传空 `input` 并设置 `enter: false`。
3. 当 `output` 显示已进入目标主机的 Shell 后，调用 `confirm_shell(session_id)`。`confirm_shell` 会向终端输入一行 `printf` 命令并回车，因此不要在口令或 MFA 提示处、也不要在菜单中调用它，否则这行命令会被当前界面当作输入处理。
4. 探测成功时返回 `ready: true`，会话状态变为 `connected`，此后可以调用 `execute`；返回值还带有 `hostname`、`prompt_line`，在二者都不包含声明的资产名时附带 `warning` 字段，提示会话可能连接到了其他主机，需要在执行命令前与用户确认——这只是提示，不会阻止会话变为 `connected`。探测失败时返回 `ready: false` 和探测之后的终端文本，不作为错误，会话仍为 `interactive`，探测命令已经被当前界面当作输入处理，可据此继续调用 `send_input`。

示例（省略 JSON-RPC 包装，只展示参数与返回值）：

```jsonc
// 1. 建立连接
connect({ "asset": "web-01" })
// => { "session_id": "sess_...", "asset": "web-01", "status": "interactive", "reused": false, "output": "Select host:" }

// 2. 输入资产名
send_input({ "session_id": "sess_...", "input": "web-01" })
// => { "session_id": "sess_...", "output": "Last login: ...\n[root@web-01 ~]#", "truncated": false, "session_state": "interactive" }

// 3. 确认已到达目标 Shell
confirm_shell({ "session_id": "sess_..." })
// => { "session_id": "sess_...", "ready": true, "session_state": "connected", "hostname": "web-01", "prompt_line": "[root@web-01 ~]#" }

// 4. 执行命令
execute({ "session_id": "sess_...", "command": "pwd" })
// => { "session_id": "sess_...", "exit_code": 0, "stdout": "/root", "duration_ms": 12, "truncated": false, "session_state": "connected" }
```

行为约定：

- 执行命令前必须先完成「连接流程」。`interactive` 状态下调用 `execute` / `cancel` 会收到错误码 `session_not_ready`；`send_input` / `confirm_shell` 仅在 `interactive` 状态可用，否则收到 `session_not_interactive`。
- 登录过程中 `ssh` 进程在两次调用之间退出时（例如 MFA 校验失败后堡垒机断开连接），会话变为 `disconnected`。如果还有未返回的终端文本，下一次 `send_input` 不写入任何内容，只返回这些文本，`session_state` 为 `disconnected`；之后的 `send_input` 和 `confirm_shell` 收到 `session_disconnected`。
- `execute` 不会自动重新连接。会话断开后需要显式重新调用 `connect`。
- 同一会话内的命令（含登录步骤）串行执行。会话忙碌时，新的 `execute` 会以 `session_busy` 被拒绝，不会排队；可等待后重试，或用 `get_session` 查询状态。
- 命令超时不会停止远程命令，会话保持忙碌状态。可调用 `cancel` 中断，或等待命令自然结束。
- `cancel` 发送 Ctrl+C 后以探测标记确认命令已结束。远程进程可能忽略该信号并读走探测命令，此时结果中 `cancelled` 为 `false`。
- 命令在伪终端中执行，`execute` 返回的 `stdout` 字段同时包含标准输出和标准错误，两者无法区分。
- 输出超过 `output_limit` 时会被截断，结果中 `truncated` 为 `true`。

## 开发

```bash
npm run check
npm run check:scripts
npm test
node scripts/smoke.mjs
```

端到端测试需要可访问的 JumpServer 和获准访问的资产：

```bash
MCP_JUMPSERVER_CONFIG=/path/to/mcp-jumpserver.yaml \
JUMPSERVER_MCP_TEST_ASSET=asset-name \
node scripts/e2e.mjs
```

如果登录该资产除输入资产名外还需要更多步骤（例如从列表中选择、选择账号），用 `JUMPSERVER_MCP_TEST_LOGIN_INPUTS` 提供后续输入，以英文逗号分隔：

```bash
JUMPSERVER_MCP_TEST_LOGIN_INPUTS=1,1 node scripts/e2e.mjs
```

其中两项检查依赖真实的堡垒机环境，无法在单元测试或 smoke 测试中验证：`300-column echo is parsed` 验证堡垒机是否把终端窗口大小的变化转发到目标主机（`confirm_shell` 在发送探测命令之前会把终端列宽从登录阶段的 200 列调整为 2048 列，以避免长命令回显折行；探测失败则改回 200 列）；`cancel` 系列检查验证探测命令在 Ctrl+C 之后经堡垒机转发仍能正常工作。

## 安全

本服务器提供远程 Shell 访问能力。请在 JumpServer 中遵循最小权限原则，并限制配置的资产白名单。白名单只校验 `connect` 声明的资产名，堡垒机账号可访问的所有主机都可以通过 `send_input` 到达，访问控制必须在 JumpServer 中实施。`interactive` 状态下 `send_input` 可以向终端写入任意文本，包括 Shell 命令，建议在 MCP Client 中为 `send_input` 设置与 `execute` 相同的审批级别。不要将配置文件和 SSH 凭据提交到版本控制。应用日志不会记录凭据：`send_input` 的输入内容和任何终端文本都不写入日志，只记录会话 ID、状态变化和输入长度。
