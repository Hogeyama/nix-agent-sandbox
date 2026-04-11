/**
 * Runtime session store.
 *
 * A lightweight, pure-logic store for tracking the live state of
 * agent sessions so the UI (and external hooks) can surface turn
 * transitions and attention notifications. Each session is persisted
 * as a single JSON file under a runtime directory.
 *
 * Environment override: `NAS_SESSION_STORE_DIR` can be set to point
 * the store at an alternate directory (used by the Commit 3 bind-mount
 * plan so hooks running inside sandboxes share the same directory as
 * the host-side UI).
 */

import * as path from "node:path";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import {
  atomicWriteJson,
  defaultRuntimeDir,
  ensureDir,
  readJsonFile,
  safeRemove,
} from "../lib/fs_utils.ts";

export type SessionTurn = "user-turn" | "agent-turn" | "done";
export type SessionEventKind = "start" | "attention" | "stop";

export interface SessionRecord {
  sessionId: string;
  agent: string;
  profile: string;
  worktree?: string;
  turn: SessionTurn;
  startedAt: string; // ISO 8601
  lastEventAt: string; // ISO 8601
  lastEventKind?: SessionEventKind;
  lastEventMessage?: string;
}

export interface SessionRuntimePaths {
  runtimeDir: string; // e.g. $XDG_RUNTIME_DIR/nas
  sessionsDir: string; // e.g. $XDG_RUNTIME_DIR/nas/sessions
}

/**
 * Resolve the on-disk location for the session store and ensure it
 * exists. Precedence:
 *   1. explicit `overrideDir` argument
 *   2. `NAS_SESSION_STORE_DIR` environment variable
 *   3. `defaultRuntimeDir("sessions")` (XDG-aware default)
 */
export async function resolveSessionRuntimePaths(
  overrideDir?: string,
): Promise<SessionRuntimePaths> {
  let sessionsDir: string;
  if (overrideDir && overrideDir.length > 0) {
    sessionsDir = overrideDir;
  } else {
    const envDir = process.env["NAS_SESSION_STORE_DIR"];
    if (envDir && envDir.trim().length > 0) {
      sessionsDir = envDir;
    } else {
      sessionsDir = defaultRuntimeDir("sessions");
    }
  }
  const runtimeDir = path.dirname(sessionsDir);
  await ensureDir(runtimeDir, 0o755);
  await ensureDir(sessionsDir);
  return { runtimeDir, sessionsDir };
}

export function sessionRecordPath(
  paths: SessionRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.sessionsDir, `${sessionId}.json`);
}

/**
 * Create a new session record with initial `turn: "user-turn"`.
 * `lastEventAt` is initialized to the provided `startedAt`.
 */
export async function createSession(
  paths: SessionRuntimePaths,
  record: Omit<SessionRecord, "turn" | "lastEventAt"> & { startedAt: string },
): Promise<SessionRecord> {
  const full: SessionRecord = {
    sessionId: record.sessionId,
    agent: record.agent,
    profile: record.profile,
    worktree: record.worktree,
    turn: "user-turn",
    startedAt: record.startedAt,
    lastEventAt: record.startedAt,
    lastEventKind: record.lastEventKind,
    lastEventMessage: record.lastEventMessage,
  };
  await atomicWriteJson(sessionRecordPath(paths, full.sessionId), full);
  return full;
}

/**
 * Read a session record by id. Returns `null` if it does not exist.
 */
export async function readSession(
  paths: SessionRuntimePaths,
  sessionId: string,
): Promise<SessionRecord | null> {
  return await readJsonFile<SessionRecord>(
    sessionRecordPath(paths, sessionId),
  );
}

/**
 * List all session records in the store. Entries that are unreadable
 * or contain malformed JSON are silently skipped so one bad file
 * cannot poison the list for the UI.
 */
export async function listSessions(
  paths: SessionRuntimePaths,
): Promise<SessionRecord[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(paths.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    try {
      const record = await readJsonFile<SessionRecord>(
        path.join(paths.sessionsDir, entry.name),
      );
      if (record) records.push(record);
    } catch {
      // Skip malformed / unreadable entries: one bad file must not
      // break the whole list for the UI.
      continue;
    }
  }
  return records;
}

function applyTransition(kind: SessionEventKind): SessionTurn {
  switch (kind) {
    case "start":
      return "agent-turn";
    case "attention":
      return "user-turn";
    case "stop":
      return "done";
  }
}

/**
 * Apply a hook event to a session record, updating `turn` per the
 * transition map:
 *   start      -> agent-turn
 *   attention  -> user-turn
 *   stop       -> done
 *
 * If no record exists (e.g. a hook arrived from outside the pipeline),
 * a partial record is created so late-arriving events still surface
 * in the UI. The partial record uses `agent = "unknown"`,
 * `profile = "unknown"` and sets `startedAt` to now.
 */
export async function updateSessionTurn(
  paths: SessionRuntimePaths,
  sessionId: string,
  kind: SessionEventKind,
  message?: string,
): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const nextTurn = applyTransition(kind);
  const existing = await readSession(paths, sessionId);

  const updated: SessionRecord = existing
    ? {
      ...existing,
      turn: nextTurn,
      lastEventAt: now,
      lastEventKind: kind,
      lastEventMessage: message ?? existing.lastEventMessage,
    }
    : {
      sessionId,
      agent: "unknown",
      profile: "unknown",
      turn: nextTurn,
      startedAt: now,
      lastEventAt: now,
      lastEventKind: kind,
      lastEventMessage: message,
    };

  await atomicWriteJson(sessionRecordPath(paths, sessionId), updated);
  return updated;
}

/**
 * Remove a session record from the store. Tolerates ENOENT so the
 * caller can safely call this more than once.
 */
export async function deleteSession(
  paths: SessionRuntimePaths,
  sessionId: string,
): Promise<void> {
  await safeRemove(sessionRecordPath(paths, sessionId));
}
