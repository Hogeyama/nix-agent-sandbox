import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  parseListeningPids,
  resolveDaemonPidsToStop,
  syncDaemonStatePid,
} from "./daemon.ts";

test("parseListeningPids: filters invalid lines and deduplicates", () => {
  expect(parseListeningPids("123\nbad\n123\n456\n")).toEqual([123, 456]);
});

test("resolveDaemonPidsToStop: prefers validated state pid", () => {
  expect(resolveDaemonPidsToStop(
    { pid: 321, port: 3939, startedAt: "2026-04-05T00:00:00.000Z" },
    [321, 654],
  )).toEqual([321]);
});

test("resolveDaemonPidsToStop: falls back to listening pids when state pid is stale", () => {
  expect(resolveDaemonPidsToStop(
    { pid: 111, port: 3939, startedAt: "2026-04-05T00:00:00.000Z" },
    [222, 333, 222],
  )).toEqual([222, 333]);
});

test("syncDaemonStatePid: writes the resolved listening pid back to state", async () => {
  let writtenState: unknown = null;

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

  expect(pid).toEqual(789);
  expect(writtenState).toEqual({
    pid: 789,
    port: 3939,
    startedAt: "2026-04-05T00:00:00.000Z",
  });
});
