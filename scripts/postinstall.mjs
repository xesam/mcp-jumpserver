// node-pty ships a spawn-helper binary on macOS that node-pty launches via
// posix_spawn; some node-pty releases lost the executable bit in the npm
// tarball, which breaks every PTY spawn with "posix_spawnp failed.".
// This script restores the executable bit and must never fail the install.
import { chmodSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function executable(path) {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function fix(path) {
  chmodSync(path, statSync(path).mode | 0o111);
  console.error(`[mcp-jumpserver] postinstall: restored exec bit on ${path}`);
}

function main() {
  if (process.platform !== "darwin") return; // spawn-helper is macOS-only
  const req = createRequire(join(pkgRoot, "package.json"));
  let ptyDir;
  try {
    ptyDir = dirname(req.resolve("node-pty/package.json"));
  } catch {
    return; // node-pty not resolvable; nothing to fix
  }
  for (const dir of [join(ptyDir, "prebuilds"), join(ptyDir, "build", "Release")]) {
    let entries;
    try {
      entries = dir.endsWith("prebuilds") ? readdirSync(dir) : ["."];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dir.endsWith("prebuilds") && !entry.startsWith("darwin")) continue;
      const helper = dir.endsWith("prebuilds") ? join(dir, entry, "spawn-helper") : join(dir, "spawn-helper");
      try {
        if (statSync(helper).isFile() && !executable(helper)) fix(helper);
      } catch {
        // missing helper layouts are fine
      }
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`[mcp-jumpserver] postinstall: permission self-heal skipped: ${err}`);
}
