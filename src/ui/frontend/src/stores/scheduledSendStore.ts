/**
 * Solid store for scheduled message sends.
 *
 * Holds an in-memory list of `ScheduledSend` entries. Entries are added
 * when the user schedules a message and removed when the message is sent
 * or cancelled. The store is not persisted: closing the tab discards all
 * pending entries.
 *
 * Reactivity is provided by a single `createSignal` holding the entries
 * array. IDs are generated with `crypto.randomUUID()`.
 */

import { createSignal } from "solid-js";
import type { ScheduledSend } from "../terminal/scheduledSendLogic";

export interface ScheduledSendStore {
  entries(): ScheduledSend[];
  add(sessionId: string, message: string, scheduledAt: Date): string;
  remove(id: string): void;
  count(): number;
}

export interface ScheduledSendStoreOptions {
  /** Injectable ID generator for deterministic testing. */
  generateId?: () => string;
  /** Injectable clock for deterministic `createdAt` timestamps. */
  now?: () => Date;
}

export function createScheduledSendStore(
  opts: ScheduledSendStoreOptions = {},
): ScheduledSendStore {
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => new Date());

  const [entries, setEntries] = createSignal<ScheduledSend[]>([]);

  return {
    entries,
    add(sessionId, message, scheduledAt) {
      const id = generateId();
      const entry: ScheduledSend = {
        id,
        sessionId,
        message,
        scheduledAt,
        createdAt: now(),
      };
      setEntries((prev) => [...prev, entry]);
      return id;
    },
    remove(id) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    count() {
      return entries().length;
    },
  };
}
