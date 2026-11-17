import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { SessionError } from "./errors.js";

export const MAX_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const AuthSchema = z.object({
  method: z.literal("ssh_key"),
  key_path: z.string().optional(),
});

const ConfigSchema = z.object({
  jumpserver: z.object({
    sshTarget: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().positive().default(22),
    username: z.string().optional(),
    auth: AuthSchema,
  }),
  ssh: z
    .object({
      connect_timeout: z.number().int().positive().default(30),
      keepalive_interval: z.number().int().positive().default(30),
    })
    .default({ connect_timeout: 30, keepalive_interval: 30 }),
  session: z
    .object({
      idle_timeout: z.number().int().positive().default(600),
      max_sessions: z.number().int().positive().default(3),
      command_timeout: z.number().int().positive().default(60),
      output_limit: z.number().int().positive().max(MAX_OUTPUT_LIMIT_BYTES).default(65536),
    })
    .default({ idle_timeout: 600, max_sessions: 3, command_timeout: 60, output_limit: 65536 }),
  assets: z.object({
    allowed: z.array(z.string()).min(1),
  }),
  expect: z
    .object({
      menu_timeout: z.number().int().positive().default(30),
      shell_timeout: z.number().int().positive().default(30),
      close_timeout: z.number().int().positive().default(10),
      quiet_period_ms: z.number().int().positive().default(1000),
      input_timeout: z.number().int().positive().default(10),
    })
    .default({ menu_timeout: 30, shell_timeout: 30, close_timeout: 10, quiet_period_ms: 1000, input_timeout: 10 }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path?: string): Config {
  const file = path ?? process.env.MCP_JUMPSERVER_CONFIG ?? "mcp-jumpserver.yaml";
  let raw: string;
  try {
    raw = readFileSync(resolve(file), "utf-8");
  } catch {
    throw new SessionError("config_invalid", `config file not readable: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new SessionError("config_invalid", `config file parse failed: ${String(err)}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SessionError("config_invalid", `config validation failed: ${result.error.message}`);
  }
  const cfg = result.data;
  if (!cfg.jumpserver.sshTarget && !cfg.jumpserver.host) {
    throw new SessionError("config_invalid", "jumpserver.sshTarget or jumpserver.host is required");
  }
  return cfg;
}
