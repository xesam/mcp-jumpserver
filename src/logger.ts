type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...data };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};
