export interface BoundedOutput {
  value: string;
  truncated: boolean;
}

export function truncateUtf8(value: string, maxBytes: number): BoundedOutput {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const end = Math.max(0, maxBytes - 3);
  for (let length = maxBytes; length >= end; length -= 1) {
    try {
      return { value: decoder.decode(bytes.subarray(0, length)), truncated: true };
    } catch {
      // A byte limit can split a multibyte code point; back up to its start.
    }
  }
  return { value: "", truncated: true };
}

export function truncateUtf8Tail(value: string, maxBytes: number): BoundedOutput {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const start = Math.min(bytes.length - maxBytes + 3, bytes.length);
  for (let offset = bytes.length - maxBytes; offset <= start; offset += 1) {
    try {
      return { value: decoder.decode(bytes.subarray(offset)), truncated: true };
    } catch {
      // A byte limit can split a multibyte code point; advance to its start.
    }
  }
  return { value: "", truncated: true };
}
