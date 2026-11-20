import { spawn as ptySpawn, type IPty } from "node-pty";
import { MAX_OUTPUT_LIMIT_BYTES, type Config } from "../config.js";
import { SessionError } from "../errors.js";
import { truncateUtf8, truncateUtf8Tail } from "../output.js";
import {
  cleanScreenText,
  doneMarkerPattern,
  generateToken,
  readyMarkerPattern,
  readyProbeCommand,
  stripTerminalNoise,
} from "../patterns.js";
import type { ExecuteResult, ScreenRead, ShellProbe } from "../types.js";
import { describePtySpawnFailure } from "./ptycheck.js";

interface Waiter {
  pattern: RegExp;
  purpose: "general" | "command";
  timer: NodeJS.Timeout;
  resolve: (m: RegExpMatchArray) => void;
  reject: (err: SessionError) => void;
}

interface QuietWait {
  check: () => void;
  finish: () => void;
}

const MAX_BUFFER_CHARS = 2 * MAX_OUTPUT_LIMIT_BYTES;
const BUFFER_TAIL_CHARS = 512;
const LOGIN_COLS = 200;
const SHELL_COLS = 2048;
const PTY_ROWS = 24;
const EXIT_TEXT_CHARS = 500;
const PROMPT_LINE_CHARS = 512;

export class ExpectRunner {
  private pty: IPty | undefined;
  private buffer: string = "";
  private bufferOverflowHead: string = "";
  private bufferTail: string = "";
  private bufferOverflow: boolean = false;
  private alive: boolean = false;
  private shellReady: boolean = false;
  private exitCode: number | undefined;
  private screenUnread: string = "";
  private screenUnreadTruncated: boolean = false;
  private screenReturned: string = "";
  private lastOutputAt: number = 0;
  private outputCount: number = 0;
  private readonly quietWaits = new Set<QuietWait>();
  private readonly config: Config;
  private readonly onExit: (exitCode: number) => void;
  private readonly waiters = new Set<Waiter>();
  private lateCompletion: { pattern: RegExp; onComplete: () => void } | undefined;
  private cancelling = false;
  private completedDuringCancel = false;

  constructor(config: Config, onExit: (exitCode: number) => void = () => undefined) {
    this.config = config;
    this.onExit = onExit;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async open(): Promise<void> {
    if (this.alive) throw new SessionError("runner_error", "runner already connected");
    this.spawnPty(LOGIN_COLS);
    await this.waitForQuiet(this.config.expect.menu_timeout * 1000, true);
    if (!this.alive) {
      if (this.exitCode === undefined) throw new SessionError("session_disconnected", "runner disposed");
      const text = this.screenText(this.screenUnread).slice(-EXIT_TEXT_CHARS);
      const suffix = text ? `: ${text}` : "";
      throw new SessionError("session_disconnected", `ssh exited with code ${this.exitCode}${suffix}`);
    }
    if (this.outputCount === 0) {
      throw new SessionError("command_timeout", "no output from ssh before menu_timeout");
    }
  }

  currentScreen(outputLimit: number): ScreenRead {
    const combined = this.screenReturned + this.screenUnread;
    if (combined.length > MAX_BUFFER_CHARS) this.screenUnreadTruncated = true;
    this.screenUnread = combined.slice(-MAX_BUFFER_CHARS);
    return this.readScreen(outputLimit);
  }

  // Returns login-phase output that has not been returned yet; also works after ssh has exited.
  takeUnreadScreen(outputLimit: number): ScreenRead {
    if (this.screenUnread === "") return { output: "", truncated: false };
    return this.readScreen(outputLimit);
  }

  async sendInput(input: string, enter: boolean, waitSec: number, outputLimit: number): Promise<ScreenRead> {
    this.ensureAlive();
    const requireNewOutput = !(input === "" && !enter && this.screenUnread !== "");
    const data = enter ? `${input}\r` : input;
    const wait = this.waitForQuiet(waitSec * 1000, requireNewOutput);
    if (data) this.send(data);
    await wait;
    return this.readScreen(outputLimit);
  }

  async confirmShell(outputLimit: number): Promise<ShellProbe> {
    this.ensureAlive();
    const lines = this.screenText(this.screenReturned + this.screenUnread).split("\n");
    let promptLine = (lines.filter((line) => line.trim() !== "").pop() ?? "").slice(-PROMPT_LINE_CHARS);

    this.pty?.resize(SHELL_COLS, PTY_ROWS);
    this.resetMatchBuffer();
    this.screenUnread = "";
    this.screenUnreadTruncated = false;
    const token = generateToken();
    this.send(`${readyProbeCommand(token)}\r`);
    try {
      await this.waitFor(readyMarkerPattern(token), this.config.expect.shell_timeout * 1000);
    } catch (err) {
      if (!(err instanceof SessionError && err.code === "command_timeout")) throw err;
      this.pty?.resize(LOGIN_COLS, PTY_ROWS);
      return { ready: false, ...this.readScreen(outputLimit) };
    }

    // The shell echoes the probe on its prompt line; that line is more reliable than
    // the screen captured before the probe, which may predate the prompt.
    const probed = cleanScreenText(this.buffer);
    const echoAt = probed.lastIndexOf(readyProbeCommand(token));
    if (echoAt >= 0) {
      const typedAt = probed.slice(probed.lastIndexOf("\n", echoAt) + 1, echoAt).trimEnd();
      if (typedAt !== "") promptLine = typedAt.slice(-PROMPT_LINE_CHARS);
    }
    this.shellReady = true;
    this.clearScreen();
    let hostname = "";
    try {
      const result = await this.execute("hostname", Math.min(this.config.expect.shell_timeout, 5), 256);
      if (result.exit_code === 0) hostname = (result.stdout.split("\n")[0] ?? "").trim();
    } catch {
      hostname = "";
    }
    return { ready: true, hostname, prompt_line: promptLine };
  }

  async execute(
    command: string,
    timeoutSec: number,
    outputLimit: number,
    onLateCompletion?: () => void,
  ): Promise<ExecuteResult> {
    this.ensureAlive();
    const token = generateToken();
    const quotedCommand = `'${command.replace(/'/g, "'\\''")}'`;
    const sent = `eval ${quotedCommand}; printf '\\n__MCP_DONE_${token}:%s\\n' "$?"`;
    const startedAt = Date.now();
    this.buffer = "";
    this.bufferOverflowHead = "";
    this.bufferTail = "";
    this.bufferOverflow = false;
    this.send(`${sent}\r`);
    const marker = doneMarkerPattern(token);
    let match: RegExpMatchArray;
    try {
      match = await this.waitFor(marker, timeoutSec * 1000, "command");
    } catch (err) {
      if (err instanceof SessionError && err.code === "command_timeout" && onLateCompletion) {
        this.lateCompletion = { pattern: marker, onComplete: onLateCompletion };
        if (this.matchBuffered(marker)) {
          this.lateCompletion = undefined;
          setTimeout(onLateCompletion, 0);
        }
      }
      throw err;
    }
    const exitCode = Number.parseInt(match[1] ?? "0", 10);

    const head = stripTerminalNoise(this.buffer);
    const cleaned = this.bufferOverflow ? head : stripTerminalNoise(this.buffer + this.bufferTail);
    const markerText = `__MCP_DONE_${token}:${exitCode}`;
    const markerIdx = cleaned.indexOf(markerText);
    let stdout: string;
    if (markerIdx >= 0) {
      let raw = cleaned.slice(0, markerIdx);
      const echoAnchor = `__MCP_DONE_${token}:%s\\n' "$?"`;
      const anchorIdx = raw.indexOf(echoAnchor);
      if (anchorIdx >= 0) raw = raw.slice(anchorIdx + echoAnchor.length);
      stdout = raw;
    } else {
      stdout = cleaned;
    }
    stdout = stdout.replace(/\r\n/g, "\n");
    stdout = stdout.replace(/__MCP_DONE_[0-9a-f]+:\d+/g, "").replace(/__MCP_READY_[0-9a-f]+:\d+/g, "");
    stdout = stdout.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, "");

    const boundedOutput = truncateUtf8(stdout, outputLimit);
    stdout = boundedOutput.value;
    const truncated = this.bufferOverflow || boundedOutput.truncated;
    this.buffer = "";
    this.bufferOverflowHead = "";
    this.bufferTail = "";
    this.bufferOverflow = false;
    return {
      session_id: "",
      exit_code: exitCode,
      stdout,
      duration_ms: Date.now() - startedAt,
      truncated,
      session_state: "busy",
    };
  }

  async cancel(): Promise<{ cancelled: boolean }> {
    this.ensureAlive();
    if (!this.shellReady) throw new SessionError("runner_error", "runner not connected");
    this.cancelling = true;
    this.completedDuringCancel = false;
    this.resetMatchBuffer();
    const token = generateToken();
    const closeTimeoutMs = this.config.expect.close_timeout * 1000;
    // The tty discards pending input when it handles the interrupt, so the probe
    // must not be typed until the terminal has reacted to Ctrl+C.
    const settled = this.waitForQuiet(Math.min(2 * this.config.expect.quiet_period_ms, closeTimeoutMs / 2), true);
    this.send("\x03");
    try {
      await settled;
      this.send(`${readyProbeCommand(token)}\r`);
      await this.waitFor(readyMarkerPattern(token), closeTimeoutMs);
      this.buffer = "";
      this.lateCompletion = undefined;
      if (this.completedDuringCancel) return { cancelled: false };
      this.rejectWaiters(
        "command",
        new SessionError("command_cancelled", "command was interrupted by cancel"),
      );
      return { cancelled: true };
    } catch (err) {
      if (err instanceof SessionError && err.code === "command_timeout") {
        return { cancelled: false };
      }
      throw err;
    } finally {
      this.cancelling = false;
    }
  }

  async close(): Promise<void> {
    if (!this.alive || !this.shellReady) return;
    this.resetMatchBuffer();
    const wait = this.waitForQuiet(this.config.expect.close_timeout * 1000, true);
    this.send("exit\r");
    await wait;
    this.buffer = "";
  }

  dispose(): void {
    const pty = this.pty;
    this.pty = undefined;
    this.alive = false;
    this.lateCompletion = undefined;
    this.dropWaiter(new SessionError("session_disconnected", "runner disposed"));
    for (const wait of this.quietWaits) wait.finish();
    if (pty) {
      try {
        pty.kill();
      } catch {
      }
    }
  }

  private spawnPty(cols: number): void {
    try {
      this.pty = ptySpawn("ssh", this.sshArgs(), {
        name: "xterm-256color",
        cols,
        rows: PTY_ROWS,
        env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as {
          [key: string]: string;
        },
        cwd: process.cwd(),
      });
    } catch (err) {
      throw new SessionError("pty_spawn_failed", describePtySpawnFailure(err));
    }
    this.alive = true;
    this.pty.onData((chunk) => this.handleData(chunk));
    this.pty.onExit(({ exitCode }) => this.handleExit(exitCode));
  }

  private sshArgs(): string[] {
    const js = this.config.jumpserver;
    const args: string[] = [
      "-o",
      `ConnectTimeout=${this.config.ssh.connect_timeout}`,
      "-o",
      `ServerAliveInterval=${this.config.ssh.keepalive_interval}`,
      "-o",
      "ServerAliveCountMax=3",
    ];
    if (js.sshTarget) {
      args.push(js.sshTarget);
      return args;
    }
    if (js.auth.key_path) args.push("-i", js.auth.key_path);
    args.push("-p", String(js.port));
    if (js.username && js.host) args.push(`${js.username}@${js.host}`);
    else if (js.host) args.push(js.host);
    return args;
  }

  private ensureAlive(): void {
    if (!this.alive || !this.pty) {
      throw new SessionError("session_disconnected", "runner not alive");
    }
  }

  private send(data: string): void {
    if (!this.pty) return;
    this.pty.write(data);
  }

  private resetMatchBuffer(): void {
    this.buffer = "";
    this.bufferOverflowHead = "";
    this.bufferTail = "";
    this.bufferOverflow = false;
  }

  private clearScreen(): void {
    this.screenUnread = "";
    this.screenUnreadTruncated = false;
    this.screenReturned = "";
  }

  private screenText(raw: string): string {
    return cleanScreenText(raw).replace(/^\n+/, "").replace(/\n+$/, "");
  }

  private readScreen(outputLimit: number): ScreenRead {
    const bounded = truncateUtf8Tail(this.screenText(this.screenUnread), outputLimit);
    const truncated = this.screenUnreadTruncated || bounded.truncated;
    if (this.screenUnread !== "") this.screenReturned = this.screenUnread;
    this.screenUnread = "";
    this.screenUnreadTruncated = false;
    return { output: bounded.value, truncated };
  }

  // Resolves once output has been quiet for quiet_period_ms (measured from the later of the last
  // output and the start of the wait), provided output arrived during the wait or new output is
  // not required. maxMs is a hard cap; process exit ends the wait immediately.
  private waitForQuiet(maxMs: number, requireNewOutput: boolean): Promise<void> {
    const startedAt = Date.now();
    const startCount = this.outputCount;
    const deadline = startedAt + maxMs;
    const quietMs = this.config.expect.quiet_period_ms;
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const wait: QuietWait = {
        finish: () => {
          clearTimeout(timer);
          this.quietWaits.delete(wait);
          resolve();
        },
        check: () => {
          const now = Date.now();
          const quietUntil = Math.max(this.lastOutputAt, startedAt) + quietMs;
          const received = this.outputCount !== startCount;
          if (!this.alive || now >= deadline || ((received || !requireNewOutput) && now >= quietUntil)) {
            wait.finish();
            return;
          }
          const wakeAt = received || !requireNewOutput ? Math.min(deadline, quietUntil) : deadline;
          clearTimeout(timer);
          timer = setTimeout(wait.check, Math.max(1, wakeAt - now));
        },
      };
      this.quietWaits.add(wait);
      wait.check();
    });
  }

  private waitFor(
    pattern: RegExp,
    timeoutMs: number,
    purpose: Waiter["purpose"] = "general",
  ): Promise<RegExpMatchArray> {
    this.ensureAlive();
    const immediate = this.matchBuffered(pattern);
    if (immediate) {
      return Promise.resolve(immediate);
    }
    return new Promise<RegExpMatchArray>((resolve, reject) => {
      const waiter: Waiter = {
        pattern,
        purpose,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new SessionError("command_timeout", `wait timeout for pattern: ${pattern.source}`));
        }, timeoutMs),
        resolve: (m) => resolve(m),
        reject: (err) => reject(err),
      };
      this.waiters.add(waiter);
    });
  }

  private dropWaiter(err: SessionError): void {
    this.rejectWaiters(undefined, err);
  }

  private rejectWaiters(purpose: Waiter["purpose"] | undefined, err: SessionError): void {
    for (const waiter of this.waiters) {
      if (purpose !== undefined && waiter.purpose !== purpose) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private handleData(chunk: string): void {
    this.lastOutputAt = Date.now();
    this.outputCount += 1;
    if (!this.shellReady) {
      this.screenUnread += chunk;
      if (this.screenUnread.length > MAX_BUFFER_CHARS) {
        this.screenUnread = this.screenUnread.slice(-MAX_BUFFER_CHARS);
        this.screenUnreadTruncated = true;
      }
    }
    const remaining = Math.max(0, MAX_BUFFER_CHARS - this.buffer.length);
    this.buffer += chunk.slice(0, remaining);
    const overflow = chunk.slice(remaining);
    if (overflow) {
      this.bufferOverflow = true;
      if (!this.bufferOverflowHead) this.bufferOverflowHead = overflow.slice(0, BUFFER_TAIL_CHARS);
      this.bufferTail = (this.bufferTail + overflow).slice(-BUFFER_TAIL_CHARS);
    }
    const late = this.lateCompletion;
    if (late && this.matchBuffered(late.pattern)) {
      this.lateCompletion = undefined;
      if (this.cancelling) this.completedDuringCancel = true;
      late.onComplete();
    }
    for (const waiter of this.waiters) {
      const match = this.matchBuffered(waiter.pattern);
      if (!match) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(match);
    }
    for (const wait of this.quietWaits) wait.check();
  }

  private matchBuffered(pattern: RegExp): RegExpMatchArray | null {
    const match = stripTerminalNoise(this.buffer).match(pattern) ?? stripTerminalNoise(this.bufferTail).match(pattern);
    if (match || !this.bufferOverflowHead) return match;
    return stripTerminalNoise(this.buffer.slice(-BUFFER_TAIL_CHARS) + this.bufferOverflowHead).match(pattern);
  }

  private handleExit(exitCode: number): void {
    this.alive = false;
    this.pty = undefined;
    this.exitCode = exitCode;
    this.dropWaiter(new SessionError("session_disconnected", `ssh process exited with code ${exitCode}`));
    for (const wait of this.quietWaits) wait.check();
    this.onExit(exitCode);
  }
}
