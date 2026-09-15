/** Docker --rm may have already removed the session-owned container. */
export function containerRemovalWarning(
  name: string,
  outcome: { exitCode: number; stderr: string } | { error: unknown },
): string | undefined {
  if ("error" in outcome) {
    const detail =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    return `[nas] Failed to remove ACP container ${name}; it may still be running: ${detail}`;
  }
  if (outcome.exitCode === 0) return undefined;
  const lines = outcome.stderr.trim().split("\n");
  if (
    lines.every(
      (line) =>
        line === `Error response from daemon: No such container: ${name}` ||
        line === `Error: No such container: ${name}`,
    )
  )
    return undefined;
  return `[nas] Failed to remove ACP container ${name}; it may still be running (exit ${outcome.exitCode}): ${outcome.stderr.trim() || "no Docker diagnostic"}`;
}
