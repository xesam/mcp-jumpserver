import type { Config } from "../config.js";
import { SessionError, toSessionError } from "../errors.js";
import { generateSessionId } from "../patterns.js";
import { logger } from "../logger.js";
import type {
  CancelResult,
  ConfirmShellResult,
  ConnectResult,
  ExecuteResult,
  ListSessionsResult,
  Session,
  SendInputResult,
  SessionInfo,
  SessionStatus,
} from "../types.js";
import { hostMismatchWarning } from "./hostcheck.js";
import { ExpectRunner } from "./runner.js";

interface SessionRecord {
  session: Session;
  runner: ExpectRunner;
}

type RunnerFactory = (config: Config, onExit: (exitCode: number) => void) => ExpectRunner;

// The status can change during an await (process exit, close, late completion). Reading it
// through a call discards the type narrowing left by an earlier assignment or check.
function currentStatus(session: Session): SessionStatus {
  return session.status;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly connecting = new Map<string, Promise<string>>();
  private readonly cancelling = new Set<string>();
  private readonly completedWhileCancelling = new Set<string>();
  private readonly loginInFlight = new Set<string>();
  private readonly config: Config;
  private readonly ownerId: string;
  private readonly runnerFactory: RunnerFactory;
  private reaper: NodeJS.Timeout | undefined;

  constructor(
    config: Config,
    ownerId: string,
    runnerFactory: RunnerFactory = (cfg, onExit) => new ExpectRunner(cfg, onExit),
  ) {
    this.config = config;
    this.ownerId = ownerId;
    this.runnerFactory = runnerFactory;
  }

  startIdleReaper(): void {
    const intervalMs = Math.min(this.config.session.idle_timeout, 300) * 1000;
    this.reaper = setInterval(() => {
      void this.reapIdleSessions();
    }, intervalMs);
    this.reaper.unref();
  }

  stopIdleReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  async shutdown(): Promise<void> {
    this.stopIdleReaper();
    for (const [id, rec] of this.sessions) {
      try {
        rec.runner.dispose();
      } catch (err) {
        logger.warn("shutdown dispose failed", { sessionId: id, err: String(err) });
      }
      rec.session.status = "closed";
    }
    this.sessions.clear();
  }

  private isAssetAllowed(asset: string): boolean {
    return this.config.assets.allowed.includes(asset);
  }

  private isDead(rec: SessionRecord): boolean {
    return !rec.runner.isAlive || ["disconnected", "error", "closed"].includes(rec.session.status);
  }

  private disposeDeadSessions(): void {
    for (const [id, rec] of this.sessions) {
      if (rec.session.status === "connecting" || !this.isDead(rec)) continue;
      rec.runner.dispose();
      this.sessions.delete(id);
    }
  }

  private findReusable(asset: string): SessionRecord | undefined {
    for (const [id, rec] of this.sessions) {
      if (rec.session.asset !== asset || rec.session.status === "connecting") continue;
      if (this.isDead(rec)) {
        rec.runner.dispose();
        this.sessions.delete(id);
        continue;
      }
      if (rec.session.status !== "closing") return rec;
    }
    return undefined;
  }

  private sessionKey(asset: string): string {
    return `${this.ownerId}|${asset}`;
  }

  private newSession(asset: string, status: SessionStatus): Session {
    return {
      id: generateSessionId(),
      ownerId: this.ownerId,
      asset,
      status,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
  }

  async connect(asset: string): Promise<ConnectResult> {
    if (!this.isAssetAllowed(asset)) {
      throw new SessionError("asset_not_allowed", `asset not in allowlist: ${asset}`);
    }
    const existing = this.findReusable(asset);
    if (existing) {
      existing.session.lastActiveAt = Date.now();
      return this.connectResult(existing.session.id, asset, true);
    }
    const key = this.sessionKey(asset);
    const pending = this.connecting.get(key);
    if (pending) {
      const sessionId = await pending;
      return this.connectResult(sessionId, asset, true);
    }
    const promise = this.createSession(asset);
    this.connecting.set(key, promise);
    try {
      const sessionId = await promise;
      return this.connectResult(sessionId, asset, false);
    } finally {
      this.connecting.delete(key);
    }
  }

  private connectResult(sessionId: string, asset: string, reused: boolean): ConnectResult {
    const rec = this.sessions.get(sessionId);
    const status = rec?.session.status ?? "closed";
    const result: ConnectResult = { session_id: sessionId, asset, status, reused };
    if (rec && status === "interactive") {
      Object.assign(result, rec.runner.currentScreen(this.config.session.output_limit));
    }
    return result;
  }

  private async createSession(asset: string): Promise<string> {
    this.disposeDeadSessions();
    if (this.sessions.size >= this.config.session.max_sessions) {
      throw new SessionError("max_sessions_exceeded", `max_sessions reached: ${this.config.session.max_sessions}`);
    }
    const session = this.newSession(asset, "connecting");
    const runner = this.runnerFactory(this.config, () => {
      if (session.status !== "closing" && session.status !== "closed" && session.status !== "error") {
        session.status = "disconnected";
        session.lastActiveAt = Date.now();
      }
    });
    this.sessions.set(session.id, { session, runner });
    try {
      await runner.open();
      if (!runner.isAlive || session.status === "disconnected") {
        throw new SessionError("session_disconnected", "SSH process exited during connection setup");
      }
      session.status = "interactive";
      logger.info("session opened", { sessionId: session.id, asset, status: session.status });
      return session.id;
    } catch (err) {
      const se = toSessionError(err);
      session.status = "error";
      runner.dispose();
      this.sessions.delete(session.id);
      throw new SessionError("connect_failed", `connect to ${asset} failed: ${se.message}`);
    }
  }

  private requireSession(sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      throw new SessionError("session_not_found", `session not found: ${sessionId}`);
    }
    if (rec.session.ownerId !== this.ownerId) {
      throw new SessionError("session_forbidden", `session not owned by this client: ${sessionId}`);
    }
    return rec;
  }

  private ensureLoginFinished(session: Session): void {
    if (session.status === "interactive") {
      throw new SessionError(
        "session_not_ready",
        `login not finished: complete the login with send_input, then call confirm_shell: ${session.id}`,
      );
    }
  }

  private disconnectedError(sessionId: string): SessionError {
    return new SessionError("session_disconnected", `session disconnected: ${sessionId}, reconnect required`);
  }

  private beginLoginStep(rec: SessionRecord): void {
    const { session } = rec;
    if (session.status !== "interactive") {
      throw new SessionError("session_not_interactive", `session not interactive (${session.status}): ${session.id}`);
    }
    if (this.loginInFlight.has(session.id)) {
      throw new SessionError("session_busy", `session busy, concurrent login input rejected: ${session.id}`);
    }
    this.loginInFlight.add(session.id);
    session.lastActiveAt = Date.now();
  }

  async sendInput(sessionId: string, input: string, enter = true, waitSec?: number): Promise<SendInputResult> {
    const rec = this.requireSession(sessionId);
    if (rec.session.status === "disconnected") {
      const unread = rec.runner.takeUnreadScreen(this.config.session.output_limit);
      if (unread.output === "") throw this.disconnectedError(sessionId);
      return { session_id: sessionId, ...unread, session_state: rec.session.status };
    }
    this.beginLoginStep(rec);
    try {
      logger.info("send_input", { sessionId, inputLength: input.length });
      const screen = await rec.runner.sendInput(
        input,
        enter,
        waitSec ?? this.config.expect.input_timeout,
        this.config.session.output_limit,
      );
      rec.session.lastActiveAt = Date.now();
      return { session_id: sessionId, ...screen, session_state: rec.session.status };
    } finally {
      this.loginInFlight.delete(sessionId);
    }
  }

  async confirmShell(sessionId: string): Promise<ConfirmShellResult> {
    const rec = this.requireSession(sessionId);
    if (rec.session.status === "disconnected") throw this.disconnectedError(sessionId);
    this.beginLoginStep(rec);
    try {
      const probe = await rec.runner.confirmShell(this.config.session.output_limit);
      rec.session.lastActiveAt = Date.now();
      const status = currentStatus(rec.session);
      if (status === "closing" || status === "closed") {
        throw new SessionError("session_closed", `session closed during confirm_shell: ${sessionId}`);
      }
      if (!rec.runner.isAlive || status === "disconnected") {
        throw new SessionError("session_disconnected", `session disconnected during confirm_shell: ${sessionId}`);
      }
      if (!probe.ready) {
        return { session_id: sessionId, ready: false, session_state: status, output: probe.output, truncated: probe.truncated };
      }
      rec.session.status = "connected";
      logger.info("session state changed", { sessionId, status: rec.session.status });
      const warning = hostMismatchWarning(rec.session.asset, probe.hostname, probe.prompt_line);
      return {
        session_id: sessionId,
        ready: true,
        session_state: rec.session.status,
        hostname: probe.hostname,
        prompt_line: probe.prompt_line,
        ...(warning ? { warning } : {}),
      };
    } finally {
      this.loginInFlight.delete(sessionId);
    }
  }

  private ensureExecutable(session: Session): void {
    this.ensureLoginFinished(session);
    if (session.status === "busy") {
      throw new SessionError("session_busy", `session busy, concurrent execute rejected: ${session.id}`);
    }
    if (session.status === "connecting") {
      throw new SessionError("session_connecting", `session still connecting: ${session.id}`);
    }
    if (session.status === "disconnected" || session.status === "error") {
      throw new SessionError("session_disconnected", `session unavailable (${session.status}): ${session.id}, reconnect required`);
    }
    if (session.status === "closing" || session.status === "closed") {
      throw new SessionError("session_closed", `session closed: ${session.id}`);
    }
  }

  async execute(sessionId: string, command: string, timeoutSec?: number, outputLimit?: number): Promise<ExecuteResult> {
    const rec = this.requireSession(sessionId);
    this.ensureExecutable(rec.session);
    rec.session.status = "busy";
    try {
      const result = await rec.runner.execute(
        command,
        timeoutSec ?? this.config.session.command_timeout,
        outputLimit ?? this.config.session.output_limit,
        () => {
          if (rec.session.status === "busy") {
            if (this.cancelling.has(sessionId)) {
              this.completedWhileCancelling.add(sessionId);
            } else {
              rec.session.status = "connected";
              rec.session.lastActiveAt = Date.now();
            }
          }
        },
      );
      const status = currentStatus(rec.session);
      if (status === "closing" || status === "closed") {
        throw new SessionError("session_closed", `session closed during command: ${sessionId}`);
      }
      if (!rec.runner.isAlive || status === "disconnected") {
        throw new SessionError("session_disconnected", `session disconnected during command: ${sessionId}`);
      }
      rec.session.status = "connected";
      rec.session.lastActiveAt = Date.now();
      return {
        session_id: sessionId,
        exit_code: result.exit_code,
        stdout: result.stdout,
        duration_ms: result.duration_ms,
        truncated: result.truncated,
        session_state: rec.session.status,
      };
    } catch (err) {
      const se = toSessionError(err);
      if (se.code === "command_timeout") {
        // The remote command may still be running, so the session stays busy.
      } else if (se.code === "command_cancelled") {
        if (rec.runner.isAlive && rec.session.status === "busy" && !this.cancelling.has(sessionId)) {
          rec.session.status = "connected";
        }
      } else {
        const status = currentStatus(rec.session);
        if (status !== "closing" && status !== "closed") {
          rec.session.status = "disconnected";
        }
      }
      throw se;
    }
  }

  async cancel(sessionId: string): Promise<CancelResult> {
    const rec = this.requireSession(sessionId);
    this.ensureLoginFinished(rec.session);
    if (this.cancelling.has(sessionId)) {
      throw new SessionError("cancel_failed", `cancel already in progress: ${sessionId}`);
    }
    if (rec.session.status !== "busy") {
      throw new SessionError("cancel_failed", `cancel requires busy session, current status: ${rec.session.status}`);
    }
    this.cancelling.add(sessionId);
    const restoreCompletedSession = (): void => {
      if (
        this.completedWhileCancelling.has(sessionId) &&
        rec.runner.isAlive &&
        rec.session.status === "busy"
      ) {
        rec.session.status = "connected";
        rec.session.lastActiveAt = Date.now();
      }
    };
    try {
      const result = await rec.runner.cancel();
      if (result.cancelled && rec.runner.isAlive && rec.session.status === "busy") {
        rec.session.status = "connected";
        rec.session.lastActiveAt = Date.now();
      } else {
        restoreCompletedSession();
      }
      return { session_id: sessionId, cancelled: result.cancelled, session_state: rec.session.status };
    } catch (err) {
      restoreCompletedSession();
      const se = toSessionError(err);
      throw new SessionError("cancel_failed", `cancel failed: ${se.message}`);
    } finally {
      this.cancelling.delete(sessionId);
      this.completedWhileCancelling.delete(sessionId);
    }
  }

  async close(sessionId: string): Promise<void> {
    const rec = this.requireSession(sessionId);
    if (this.cancelling.has(sessionId)) {
      throw new SessionError("session_busy", `cannot close while cancellation is in progress: ${sessionId}`);
    }
    if (rec.session.status === "closing" || rec.session.status === "closed") {
      throw new SessionError("session_closed", `session already closing or closed: ${sessionId}`);
    }
    const wasBusy = rec.session.status === "busy";
    rec.session.status = "closing";
    try {
      if (wasBusy) {
        try {
          await rec.runner.cancel();
        } catch (err) {
          logger.warn("pre-close cancel failed, forcing close", { sessionId, err: String(err) });
        }
      }
      await rec.runner.close();
    } catch (err) {
      logger.warn("graceful close failed, disposing runner", { sessionId, err: String(err) });
    } finally {
      rec.runner.dispose();
      rec.session.status = "closed";
      rec.session.lastActiveAt = Date.now();
      this.sessions.delete(sessionId);
    }
  }

  getSession(sessionId: string): SessionInfo {
    const rec = this.requireSession(sessionId);
    return {
      session_id: rec.session.id,
      asset: rec.session.asset,
      status: rec.session.status,
      created_at: new Date(rec.session.createdAt).toISOString(),
      last_active_at: new Date(rec.session.lastActiveAt).toISOString(),
    };
  }

  listSessions(): ListSessionsResult {
    return {
      sessions: Array.from(this.sessions.values()).map((rec) => ({
        session_id: rec.session.id,
        asset: rec.session.asset,
        status: rec.session.status,
      })),
    };
  }

  private async reapIdleSessions(): Promise<void> {
    const threshold = Date.now() - this.config.session.idle_timeout * 1000;
    for (const [id, rec] of this.sessions) {
      if (rec.session.lastActiveAt < threshold && rec.session.status !== "busy") {
        logger.info("reaping idle session", { sessionId: id, asset: rec.session.asset });
        try {
          await this.close(id);
        } catch (err) {
          logger.warn("idle reap close failed", { sessionId: id, err: String(err) });
        }
      }
    }
  }
}
