import { assertEquals } from "@std/assert";
import {
  parseListeningPids,
  resolveDaemonPidsToStop,
  syncDaemonStatePid,
} from "./daemon.ts";

Deno.test("parseListeningPids: filters invalid lines and deduplicates", () => {
  assertEquals(parseListeningPids("123\nbad\n123\n456\n"), [123, 456]);
});

Deno.test("resolveDaemonPidsToStop: prefers validated state pid", () => {
  assertEquals(
    resolveDaemonPidsToStop(
      { pid: 321, port: 3939, startedAt: "2026-04-05T00:00:00.000Z" },
      [321, 654],
    ),
    [321],
  );
});

Deno.test("resolveDaemonPidsToStop: falls back to listening pids when state pid is stale", () => {
  assertEquals(
    resolveDaemonPidsToStop(
      { pid: 111, port: 3939, startedAt: "2026-04-05T00:00:00.000Z" },
      [222, 333, 222],
    ),
    [222, 333],
  );
});

Deno.test("syncDaemonStatePid: writes the resolved listening pid back to state", async () => {
  let writtenState:
    | { pid?: number; port: number; startedAt: string }
    | null = null;

  const pid = await syncDaemonStatePid(3939, {
    readState: () =>
      Promise.resolve({
        port: 3939,
        startedAt: "2026-04-05T00:00:00.000Z",
      }),
    listListeningPids: () => Promise.resolve([789]),
    writeState: (state) => {
      writtenState = state;
      return Promise.resolve();
    },
  });

  assertEquals(pid, 789);
  assertEquals(writtenState, {
    pid: 789,
    port: 3939,
    startedAt: "2026-04-05T00:00:00.000Z",
  });
});
