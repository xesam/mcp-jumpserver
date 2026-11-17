export function doneMarkerPattern(token: string): RegExp {
  return new RegExp(`__MCP_DONE_${token}:(\\d+)`);
}

export function readyMarkerPattern(token: string): RegExp {
  return new RegExp(`__MCP_READY_${token}:(\\d+)`);
}

export function readyProbeCommand(token: string): string {
  return `printf '\\n__MCP_READY_${token}:%s\\n' "$?"`;
}

function stripEscapeSequences(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b\[[0-9;?<=>]*[A-Za-z]/g, "")
    .replace(/\x07/g, "");
}

export function stripTerminalNoise(text: string): string {
  return stripEscapeSequences(text).replace(/\x08/g, "");
}

// East Asian wide characters occupy two terminal cells, so erasing one takes two backspaces.
function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd))
    ? 2
    : 1;
}

function applyBackspaces(line: string): string {
  if (!line.includes("\x08")) return line;
  const cells: string[] = [];
  let cursor = 0;
  for (const char of line) {
    if (char === "\x08") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    const width = cellWidth(char);
    cells[cursor] = char;
    if (width === 2) cells[cursor + 1] = "";
    cursor += width;
  }
  return Array.from(cells, (cell) => cell ?? " ").join("");
}

export function cleanScreenText(raw: string): string {
  return stripEscapeSequences(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => applyBackspaces(line).replace(/[ \t]+$/, ""))
    .join("\n");
}

export function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "sess_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
