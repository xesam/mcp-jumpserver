# AGENTS.md

This file provides guidance to Code Agent when working with code in this repository.

## 项目概述

`mcp-jumpserver` 是一个 stdio 传输的 MCP Server（npm 包，ESM，Node.js >= 20），通过 OpenSSH + PTY（`node-pty`）连接 JumpServer / KoKo，为 MCP Client 提供持久 Shell 会话。登录交互（菜单导航、资产/账号选择、口令或 MFA）由 MCP Client 侧的 agent 驱动，服务端不解析菜单或 Shell 提示符格式。对外暴露 8 个工具：`connect`、`send_input`、`confirm_shell`、`execute`、`cancel`、`get_session`、`list_sessions`、`close`。

## 常用命令

```bash
npm run build          # tsc，输出到 dist/
npm run check          # 仅类型检查（tsc --noEmit）
npm run check:scripts  # 对 scripts/*.mjs 做语法检查
npm test               # 先 build，再运行 node --test tests/*.test.mjs
node scripts/smoke.mjs # 通过 stdio 启动 dist/index.js，校验工具列表与基础错误码（需先 build）
```

运行单个测试（测试从 `dist/` 导入，修改 `src/` 后必须先 build）：

```bash
npm run build && node --test --test-name-pattern="<测试名片段>" tests/mvp.test.mjs
```

端到端测试需要真实的 JumpServer 和已授权资产：

```bash
MCP_JUMPSERVER_CONFIG=/path/to/mcp-jumpserver.yaml \
JUMPSERVER_MCP_TEST_ASSET=asset-name \
node scripts/e2e.mjs
```

项目没有配置 lint 和格式化工具。

## 架构

调用链为 `src/index.ts` → `src/tools/index.ts` → `src/session/manager.ts` → `src/session/runner.ts`，分三层：

- **工具层（`tools/index.ts`）**：用 zod 定义入参并注册 MCP 工具。`callTool` 统一把 `SessionError` 转成 `{ error: <code>, message }` 且 `isError: true` 的 JSON 文本返回。新增错误码时在 `errors.ts` 的 `ErrorCode` 联合类型中登记。
- **会话管理层（`SessionManager`）**：负责会话状态机、资产白名单、归属校验、`max_sessions` 限制、空闲回收。不直接接触 PTY。
- **PTY 层（`ExpectRunner`）**：一个实例对应一个 `ssh` 子进程，按 expect 方式（发送输入、等待输出匹配正则）驱动交互。

### 会话状态机

状态定义在 `types.ts` 的 `SessionStatus`：`connecting → interactive → connected ⇄ busy`，以及 `disconnected / closing / closed / error`。`connect` 建立 SSH 连接、等到首屏输出静默后，会话进入 `interactive`；`interactive` 状态下通过 `send_input` 反复操作，再由 `confirm_shell` 探测成功后迁移到 `connected`。修改 `manager.ts` 时需要保持以下行为，它们都有对应测试：

- 同一 owner + asset 复用会话，`interactive` 状态的会话同样参与复用；并发的 `connect` 通过 `connecting` Map 共享同一个 Promise，只建立一条 SSH 连接。
- `interactive` 状态下 `execute` / `cancel` 返回错误码 `session_not_ready`；`send_input` / `confirm_shell` 仅在 `interactive` 状态可用，否则返回 `session_not_interactive`；`disconnected` 状态例外：`send_input` 先由 `runner.takeUnreadScreen` 一次性返回登录阶段尚未返回的终端文本（不写入 PTY），没有未读文本时与 `confirm_shell` 一样返回 `session_disconnected`。同一会话的登录步骤（`send_input`、`confirm_shell`）之间互斥，重叠调用返回 `session_busy`。
- 同一会话内命令串行，`busy` 状态下再次 `execute` 直接返回 `session_busy`，不排队。
- 命令超时后会话保持 `busy`（远程命令可能仍在运行）。之后若完成标记到达，由 runner 的 `lateCompletion` 回调把会话恢复为 `connected`。
- `cancel` 发送 Ctrl+C 后先等待输出停止（最长为 `2 * quiet_period_ms` 与 `close_timeout / 2` 中的较小值），再发送与 `confirm_shell` 相同的探测命令：终端处理中断信号时会清空输入队列，紧跟 Ctrl+C 发送的探测命令会丢失开头字符。之后以探测标记在 `close_timeout` 内出现作为成功依据。`cancelling` / `completedWhileCancelling` 两个集合用于处理“取消过程中命令自然结束”的竞态。
- 不自动重连：SSH 进程退出后会话置为 `disconnected`，下一次 `connect` 时由 `findReusable` 清理并新建会话；`createSession` 在检查 `max_sessions` 之前先清理所有已失效的会话（runner 已退出或状态为 `disconnected` / `error` / `closed`）。
- `close`：`interactive` 状态直接 `dispose`；`connected` / `busy` 状态先发送 `exit` 让目标 Shell 正常结束，等待输出静默或 SSH 进程退出，最长 `close_timeout`，随后都 `dispose` 杀掉 PTY 以断开与堡垒机的连接。不向 JumpServer 菜单发送 `q`。

### 命令执行与输出解析（`runner.ts` + `patterns.ts`）

- 服务端不匹配菜单或 Shell 提示符格式。`interactive` 阶段输出是否结束只按时间判定：连续 `expect.quiet_period_ms` 没有新输出视为静默，达到调用方给定的最长等待时间时返回当前已有内容。`send_input` 不清空缓冲区，返回自上次返回以来的全部输出，覆盖“静默判定期间响应延迟到达”的情况。
- `confirm_shell` 发送探测命令 `printf '\n__MCP_READY_<token>:%s\n' "$?"`，在 `shell_timeout` 内等待探测标记 `__MCP_READY_<token>:\d+`；`cancel` 在发送 Ctrl+C 并等待输出停止后发送同一探测命令，在 `close_timeout` 内等待。回显中的字面量 `%s` 不会误匹配标记正则。
- `confirm_shell` 返回的 `prompt_line` 取探测命令回显所在行中回显之前的文本；找不到回显时退回到探测之前的最后一个非空行。返回给 agent 的终端文本由 `cleanScreenText` 处理，其中退格符按终端的实际显示效果应用（宽字符占两格）。
- 每条命令包装为 `eval '<转义后的命令>'; printf '\n__MCP_DONE_<token>:%s\n' "$?"`，通过随机 token 的完成标记判定结束并取得退出码；`stdout` 是剥离回显、ANSI 控制序列和标记后的 PTY 输出（stdout 与 stderr 混合）。
- PTY 列宽分阶段设置：`interactive` 阶段为 200 列，避免菜单按宽列排版产生大量填充空白；`confirm_shell` 在发送探测命令之前把列宽调整为 2048，保持 `execute` 长命令回显不折行的前提，探测失败则改回 200 列。
- 缓冲区上限为 `2 * MAX_OUTPUT_LIMIT_BYTES`，溢出后只保留头部和末尾 512 字符用于匹配标记，并将结果标记为 `truncated`。最终输出由 `output.ts` 的 `truncateUtf8` 按 UTF-8 字节边界截断。

### 配置

`config.ts` 用 zod 校验 YAML。配置文件路径取自 `MCP_JUMPSERVER_CONFIG`，默认为当前工作目录下的 `mcp-jumpserver.yaml`（相对路径按进程工作目录解析）。`jumpserver.sshTarget`（`~/.ssh/config` 中的 Host 别名）与 `jumpserver.host` 至少提供一个；设置了 `sshTarget` 时忽略 `host`/`port`/`username`/`key_path`。配置字段有变更时同步更新 `mcp-jumpserver.example.yaml` 和两份 README。

### 日志

stdout 是 MCP 协议通道，任何日志都必须通过 `logger.ts` 写入 stderr（JSON 行格式），不要使用 `console.log`。

## 测试

`tests/mvp.test.mjs` 使用 `node:test`，包含两类用例：

- 单元级：向 `SessionManager` 构造函数的第三个参数 `runnerFactory` 注入伪造的 runner，验证状态机行为；或直接对 `ExpectRunner` 的私有成员注入数据。
- 进程级：在临时目录生成伪造的 `ssh` 可执行文件（`FAKE_SSH_SCRIPT`）并置于 `PATH` 最前，再通过 stdio 启动 `dist/index.js`，验证 PTY 清理和进程退出行为。该脚本用一个 `read` 循环模拟菜单：持续打印 `Select host: ` 并读入一行，输入等于 `asset-name` 时跳出循环，否则打印 `no such host` 重新提示；跳出后用 `exec /bin/bash --noprofile --norc -i` 替换为一个真实的交互式 bash（提示符取自 `SSH_TEST_PS1` 环境变量）模拟目标主机 Shell，交由 `send_input` / `confirm_shell` 驱动。

测试和 `scripts/smoke.mjs` 都以相对路径读取 `mcp-jumpserver.example.yaml`（其中白名单资产名为 `asset-name`），因此必须在仓库根目录运行，且修改该示例文件可能影响测试。

## 仓库约定

- `README.md`（中文）与 `README.en.md`（英文）内容对应，修改时两份同步。
- `.gitignore` 忽略所有以 `.` 开头的文件和目录（`.gitignore`、`example/.mcp.json`、`example/.codex/config.toml` 除外）；`.local/` 存放本地设计文档和实验记录，不纳入版本控制。
- `example/mcp-jumpserver.yaml` 是受跟踪的示例配置，其中的资产名和密钥文件名是可公开的示例值。
- `example/` 是独立的 MCP Client 接入示例（Claude Code 的 `.mcp.json`、OpenCode 的 `opencode.json`、Codex 的 `.codex/config.toml`），直接引用 `../dist/index.js`。
- `prepack` 会执行 build；发布内容由 `package.json` 的 `files` 字段限定。
