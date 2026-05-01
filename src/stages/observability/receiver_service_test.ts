/**
 * OtlpReceiverService tests — covers Live (real Bun.serve startup against a
 * tmp SQLite db) and Fake (no-op handle, onStart spy) layer behaviour.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Cause, Effect, Exit } from "effect";
import type { StartOtlpReceiverOptions } from "../../history/receiver.ts";
import { _closeHistoryDb, openHistoryDb } from "../../history/store.ts";
import {
  makeOtlpReceiverServiceFake,
  OtlpReceiverService,
  OtlpReceiverServiceLive,
} from "./receiver_service.ts";

let tmpRoot = "";
let dbPath = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-otlp-svc-"));
  dbPath = path.join(tmpRoot, "history.db");
});

afterEach(async () => {
  if (dbPath) _closeHistoryDb(dbPath);
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

test("OtlpReceiverServiceLive.start: starts a listener on a non-zero port and closes cleanly", async () => {
  const db = openHistoryDb({ path: dbPath, mode: "readwrite" });

  const program = Effect.gen(function* () {
    const svc = yield* OtlpReceiverService;
    const handle = yield* svc.start({ db });
    expect(handle.port).toBeGreaterThan(0);
    yield* Effect.tryPromise({
      try: () => handle.close(),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });
  }).pipe(Effect.provide(OtlpReceiverServiceLive));

  await Effect.runPromise(program);
});

test("OtlpReceiverServiceLive.start: failed bind surfaces as a tagged Error in the Effect channel", async () => {
  const db = openHistoryDb({ path: dbPath, mode: "readwrite" });

  // Take a port, then request the same port to force EADDRINUSE.
  const first = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  try {
    const program = Effect.gen(function* () {
      const svc = yield* OtlpReceiverService;
      return yield* svc.start({ db, port: first.port });
    }).pipe(Effect.provide(OtlpReceiverServiceLive));

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // The bind failure must surface through the Error channel as an
      // address-in-use diagnostic — not a generic "promise rejected" wrapper —
      // so callers can branch on it. Match either the POSIX errno spelling
      // ("EADDRINUSE") or the human phrasing Bun emits on some platforms
      // ("address already in use" / "address in use").
      // Match the actual bind-failure diagnostics across platforms / Bun
      // versions. Observed phrasings:
      //   - POSIX errno: "EADDRINUSE"
      //   - Bun (Linux/macOS): "Failed to start server. Is port N in use?"
      //   - Some libuv builds: "address already in use" / "address in use"
      // All three legitimately encode "the requested port could not be bound
      // because something else is already on it"; any other phrasing would
      // mean we mis-attributed the failure.
      const msg = Cause.pretty(exit.cause).toLowerCase();
      const matched =
        msg.includes("eaddrinuse") ||
        (msg.includes("address") && msg.includes("in use")) ||
        (msg.includes("port") && msg.includes("in use"));
      expect(matched).toBe(true);
    }
  } finally {
    await first.stop(true);
  }
});

test("makeOtlpReceiverServiceFake: onStart observes options, handle reports configured port, close is no-op", async () => {
  const db = openHistoryDb({ path: dbPath, mode: "readwrite" });
  const seen: StartOtlpReceiverOptions[] = [];
  const fake = makeOtlpReceiverServiceFake({
    port: 4318,
    onStart: (opts) => {
      seen.push(opts);
    },
  });

  const program = Effect.gen(function* () {
    const svc = yield* OtlpReceiverService;
    const handle = yield* svc.start({ db });
    expect(handle.port).toEqual(4318);
    yield* Effect.tryPromise({
      try: () => handle.close(),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });
    // Idempotent.
    yield* Effect.tryPromise({
      try: () => handle.close(),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });
  }).pipe(Effect.provide(fake));

  await Effect.runPromise(program);

  expect(seen.length).toEqual(1);
  expect(seen[0].db).toBe(db);
});

test("makeOtlpReceiverServiceFake: default port is 0 when not specified", async () => {
  const db = openHistoryDb({ path: dbPath, mode: "readwrite" });
  const fake = makeOtlpReceiverServiceFake();

  const program = Effect.gen(function* () {
    const svc = yield* OtlpReceiverService;
    const handle = yield* svc.start({ db });
    expect(handle.port).toEqual(0);
  }).pipe(Effect.provide(fake));

  await Effect.runPromise(program);
});

test("makeOtlpReceiverServiceFake: multiple start() calls each invoke onStart", async () => {
  const db = openHistoryDb({ path: dbPath, mode: "readwrite" });
  let count = 0;
  const fake = makeOtlpReceiverServiceFake({
    onStart: () => {
      count += 1;
    },
  });

  const program = Effect.gen(function* () {
    const svc = yield* OtlpReceiverService;
    yield* svc.start({ db });
    yield* svc.start({ db });
    yield* svc.start({ db });
  }).pipe(Effect.provide(fake));

  await Effect.runPromise(program);
  expect(count).toEqual(3);
});
