import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { claimSessionId, SessionIdInUseError } from "./ownership.ts";

function hasFlock(): boolean {
  try {
    return Bun.spawnSync(["flock", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

function hasProcStartTime(): boolean {
  try {
    // A sandbox can run in its own PID namespace while showing another
    // namespace's /proc, where this PID's stat belongs to another process.
    if (readlinkSync("/proc/self") !== String(process.pid)) return false;
    return readFileSync(`/proc/${process.pid}/stat`, "utf8").length > 0;
  } catch {
    return false;
  }
}

const flockAvailable = hasFlock();
const procAvailable = hasProcStartTime();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nas-session-owners-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!flockAvailable || !procAvailable)(
  "claimSessionId refuses an id a live process already owns",
  () => {
    const first = claimSessionId("sess_aaa", dir);
    try {
      expect(() => claimSessionId("sess_aaa", dir)).toThrow(
        SessionIdInUseError,
      );
    } finally {
      first.release();
    }
  },
);

test.skipIf(!flockAvailable || !procAvailable)(
  "claimSessionId lets the id be claimed again after release",
  () => {
    claimSessionId("sess_aaa", dir).release();
    claimSessionId("sess_aaa", dir).release();
    expect(existsSync(path.join(dir, "sess_aaa.owner"))).toBe(false);
  },
);

test.skipIf(!flockAvailable || !procAvailable)(
  "releasing twice leaves a later claim in the same process alone",
  () => {
    const first = claimSessionId("sess_aaa", dir);
    first.release();
    const second = claimSessionId("sess_aaa", dir);
    try {
      first.release();
      expect(() => claimSessionId("sess_aaa", dir)).toThrow(
        SessionIdInUseError,
      );
    } finally {
      second.release();
    }
  },
);

test.skipIf(!flockAvailable || !procAvailable)(
  "parallel claims have one winner, including stale-owner takeover",
  async () => {
    const rounds = 50;
    const contenders = 16;
    const modulePath = path.join(import.meta.dir, "ownership.ts");
    const worker = `
    import { claimSessionId, SessionIdInUseError } from ${JSON.stringify(modulePath)};
    import { existsSync, renameSync, writeFileSync } from "node:fs";
    const [dir, workerId] = process.argv.slice(1);
    for (let round = 0; round < ${rounds}; round++) {
      while (!existsSync(dir + "/go-" + round)) await Bun.sleep(1);
      let ownership;
      try {
        ownership = claimSessionId("sess_" + round, dir);
      } catch (error) {
        if (!(error instanceof SessionIdInUseError)) throw error;
      }
      const result = dir + "/result-" + round + "-" + workerId;
      writeFileSync(result + ".tmp", ownership ? "won" : "lost");
      renameSync(result + ".tmp", result);
      while (!existsSync(dir + "/done-" + round)) await Bun.sleep(1);
      ownership?.release();
    }
  `;
    const children: Bun.Subprocess[] = [];
    try {
      for (let index = 0; index < contenders; index++) {
        children.push(
          Bun.spawn([process.execPath, "-e", worker, dir, String(index)], {
            stdout: "ignore",
            stderr: "inherit",
          }),
        );
      }
      const deadline = Date.now() + 10_000;
      for (let round = 0; round < rounds; round++) {
        if (round % 2 === 1) {
          writeFileSync(
            path.join(dir, `sess_${round}.owner`),
            `${process.pid} 0\n`,
          );
        }
        const results = children.map((_, index) =>
          path.join(dir, `result-${round}-${index}`),
        );
        writeFileSync(path.join(dir, `go-${round}`), "");
        while (!results.every((file) => existsSync(file))) {
          if (Date.now() >= deadline)
            throw new Error("claim workers timed out");
          await Bun.sleep(1);
        }
        expect(
          results.filter((file) => readFileSync(file, "utf8") === "won").length,
        ).toBe(1);
        writeFileSync(path.join(dir, `done-${round}`), "");
      }
      expect(await Promise.all(children.map((child) => child.exited))).toEqual(
        Array(contenders).fill(0),
      );
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  },
  15_000,
);

test.skipIf(!flockAvailable || !procAvailable)(
  "claimSessionId takes over an id whose owner is gone",
  () => {
    // pid 自体が生きていても、起動時刻が違えば pid が再利用された別プロセス。
    writeFileSync(path.join(dir, "sess_aaa.owner"), `${process.pid} 0\n`);
    claimSessionId("sess_aaa", dir).release();
  },
);

test.skipIf(!flockAvailable || !procAvailable)(
  "release leaves an owner file written by another process alone",
  () => {
    const ownership = claimSessionId("sess_aaa", dir);
    const ownerPath = path.join(dir, "sess_aaa.owner");
    writeFileSync(ownerPath, "1 12345\n");
    ownership.release();
    expect(existsSync(ownerPath)).toBe(true);
  },
);
