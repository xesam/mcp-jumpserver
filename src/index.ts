#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { SessionManager } from "./session/manager.js";
import { registerTools } from "./tools/index.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new SessionManager(config, "local");
  manager.startIdleReaper();

  const server = new McpServer({ name: "jumpserver-mcp", version });
  registerTools(server, manager);

  const transport = new StdioServerTransport();
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (reason: string): void => {
    if (shutdownTask) return;
    shutdownTask = (async () => {
      logger.info("shutting down", { reason });
      await manager.shutdown();
      process.exit(0);
    })();
  };

  transport.onclose = () => shutdown("stdio transport closed");
  process.stdin.on("end", () => shutdown("stdin ended"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(transport);
  logger.info("jumpserver-mcp started", {
    stdio: true,
    assets: config.assets.allowed,
    idleTimeout: config.session.idle_timeout,
  });
}

main().catch((err) => {
  logger.error("fatal", { err: String(err) });
  process.exit(1);
});
