import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { SessionError } from "../errors.js";

// POSIX PATH lookup for the preflight check; on Windows only existence matters.
export function findExecutableInPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathEnv = env.PATH ?? env.Path;
  if (!name || !pathEnv) return undefined;
  const candidates = platform === "win32" ? [name, `${name}.exe`] : [name];
  const needsExecBit = platform !== "win32";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (needsExecBit && (st.mode & 0o111) === 0) continue;
        return full;
      } catch {
        // absent entries are skipped
      }
    }
  }
  return undefined;
}

export function assertSshInPath(context: string): void {
  if (findExecutableInPath("ssh")) return;
  throw new SessionError(
    "ssh_not_found",
    `${context}: ssh executable not found in PATH of the MCP server process. Install the OpenSSH client, or fix PATH in the environment that launches the MCP host (current PATH: ${process.env.PATH ?? "<empty>"})`,
  );
}

// node-pty launches a spawn-helper binary via posix_spawn on macOS; a missing
// executable bit there is the classic cause of "posix_spawnp failed.".
export function nodePtySpawnHelperPaths(): { path: string; executable: boolean }[] {
  if (process.platform !== "darwin") return [];
  let pkg;
  try {
    pkg = createRequire(import.meta.url).resolve("node-pty/package.json");
  } catch {
    return [];
  }
  const root = dirname(pkg);
  const out: { path: string; executable: boolean }[] = [];
  for (const helper of [
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ]) {
    try {
      const st = statSync(helper);
      if (st.isFile()) out.push({ path: helper, executable: (st.mode & 0o111) !== 0 });
    } catch {
      // absent layouts are fine
    }
  }
  return out;
}

export function describePtySpawnFailure(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  const parts = [`node-pty failed to spawn the ssh process (${reason}).`];
  if (!findExecutableInPath("ssh")) {
    parts.push(
      `ssh is not in PATH of the MCP server process; install the OpenSSH client or fix PATH (current PATH: ${process.env.PATH ?? "<empty>"}).`,
    );
  }
  for (const helper of nodePtySpawnHelperPaths()) {
    if (!helper.executable) parts.push(`node-pty spawn-helper is missing the executable bit; run: chmod +x ${helper.path}`);
  }
  if (parts.length === 1) parts.push("Verify that ssh can be started and that node-pty is installed correctly.");
  return parts.join(" ");
}
