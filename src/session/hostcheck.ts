export function hostMismatchWarning(asset: string, hostname: string, promptLine: string): string | undefined {
  const needle = asset.toLowerCase();
  const hostnameMatches = hostname !== "" && hostname.toLowerCase().includes(needle);
  const promptMatches = promptLine !== "" && promptLine.toLowerCase().includes(needle);
  if (hostnameMatches || promptMatches) return undefined;

  return `Declared asset "${asset}" was not found in hostname "${hostname}" or prompt line "${promptLine}". The session may be on a different host. Confirm with the user before executing commands.`;
}
