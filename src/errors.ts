export type ErrorCode =
  | "config_invalid"
  | "asset_not_allowed"
  | "max_sessions_exceeded"
  | "session_not_found"
  | "session_forbidden"
  | "session_busy"
  | "session_connecting"
  | "session_disconnected"
  | "session_closed"
  | "connect_failed"
  | "command_timeout"
  | "command_cancelled"
  | "cancel_failed"
  | "runner_error"
  | "session_not_interactive"
  | "session_not_ready";

export class SessionError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export function toSessionError(err: unknown): SessionError {
  if (err instanceof SessionError) return err;
  if (err instanceof Error) return new SessionError("runner_error", err.message);
  return new SessionError("runner_error", String(err));
}
