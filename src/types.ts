export type SessionStatus =
  | "connecting"
  | "connected"
  | "busy"
  | "interactive"
  | "disconnected"
  | "closing"
  | "closed"
  | "error";

export interface Session {
  id: string;
  ownerId: string;
  asset: string;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
}

export interface ConnectResult {
  session_id: string;
  asset: string;
  status: SessionStatus;
  reused: boolean;
  output?: string;
  truncated?: boolean;
}

export interface ScreenRead {
  output: string;
  truncated: boolean;
}

export type ShellProbe =
  | { ready: true; hostname: string; prompt_line: string }
  | { ready: false; output: string; truncated: boolean };

export interface SendInputResult {
  session_id: string;
  output: string;
  truncated: boolean;
  session_state: SessionStatus;
}

export interface ConfirmShellResult {
  session_id: string;
  ready: boolean;
  session_state: SessionStatus;
  hostname?: string;
  prompt_line?: string;
  warning?: string;
  output?: string;
  truncated?: boolean;
}

export interface ExecuteResult {
  session_id: string;
  exit_code: number | null;
  stdout: string;
  duration_ms: number;
  truncated: boolean;
  session_state: SessionStatus;
}

export interface CancelResult {
  session_id: string;
  cancelled: boolean;
  session_state: SessionStatus;
}

export interface SessionInfo {
  session_id: string;
  asset: string;
  status: SessionStatus;
  created_at: string;
  last_active_at: string;
}

export interface SessionSummary {
  session_id: string;
  asset: string;
  status: SessionStatus;
}

export interface ListSessionsResult {
  sessions: SessionSummary[];
}
