/**
 * Pure helper for extracting a conversation summary from a Claude Code
 * transcript JSONL.
 *
 * The transcript schema is not part of any stable contract, so the parser
 * is defensive: it understands a handful of plausible variants for the
 * "first user-typed message" shape and ignores anything else. Any read,
 * parse, or extraction failure surfaces as `null`; callers (the hook
 * writer) treat that as a no-op.
 */

import { readFileSync } from "node:fs";

export interface ExtractTranscriptSummaryOptions {
  /** Hard truncation in characters. Default 160. */
  readonly maxChars?: number;
}

/** Defensive cap on transcript lines scanned per call. */
const MAX_LINES_SCANNED = 32;

const DEFAULT_MAX_CHARS = 160;

/**
 * Read the first user-typed message from a Claude Code transcript JSONL.
 *
 * Returns null if the file is missing, unreadable, or contains no
 * user-typed entry within the first {@link MAX_LINES_SCANNED} lines.
 *
 * NOTE: `transcriptPath` is treated as agent-trusted: any file the hook
 * process can read can land (truncated) in `conversation_summaries.summary`.
 * A malicious agent inside the sandbox can already exfiltrate via other
 * channels (network, hostexec), so a path-prefix allowlist would not raise
 * the bar; we accept the simpler design.
 */
export function extractTranscriptSummary(
  transcriptPath: string,
  opts?: ExtractTranscriptSummaryOptions,
): string | null {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  const limit = Math.min(lines.length, MAX_LINES_SCANNED);
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const text = extractUserText(parsed);
    if (text === null) continue;
    const normalized = normalize(text);
    if (normalized.length === 0) continue;
    return truncate(normalized, maxChars);
  }
  return null;
}

/**
 * Pull the user-typed text out of a parsed transcript entry.
 *
 * Accepts the variants observed in Claude Code transcripts:
 *  - `{ type: "user", message: { content: string | Array } }`
 *  - `{ role: "user", content: string | Array }`
 *
 * Returns null for non-user entries or entries without a text payload.
 */
function extractUserText(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const obj = entry as Record<string, unknown>;
  if (!isUserEntry(obj)) return null;

  const messageContent = readMessageContent(obj.message);
  if (messageContent !== null) return messageContent;

  return readContent(obj.content);
}

function isUserEntry(obj: Record<string, unknown>): boolean {
  if (obj.type === "user") return true;
  if (obj.role === "user") return true;
  return false;
}

function readMessageContent(message: unknown): string | null {
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return null;
  }
  const inner = (message as Record<string, unknown>).content;
  return readContent(inner);
}

function readContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.type !== "text") continue;
    if (typeof obj.text === "string") parts.push(obj.text);
  }
  if (parts.length === 0) return null;
  const joined = parts.join(" ");
  return joined.length > 0 ? joined : null;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Hard-truncate `s` to at most `maxChars` characters, replacing the final
 * character with U+2026 (`…`) when truncation occurs. The ellipsis counts
 * toward the length budget, so the returned string is always
 * `<= maxChars` characters long. Defensive guard: returns `""` for
 * non-positive `maxChars`.
 */
export function truncate(s: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}
