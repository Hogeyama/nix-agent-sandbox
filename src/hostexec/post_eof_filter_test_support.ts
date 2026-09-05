import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * These waits bound how long a filter process may take to appear or to be
 * reaped, not how fast the code under test is expected to be. Two seconds was
 * enough on an idle host; under a full parallel suite -- and inside a sandbox,
 * where every `bun` here is another process on the same contended cores -- it
 * turned prompt cleanup into a flaky failure. Ten still fails a filter that
 * never goes away, which is what the assertion is for.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const FILTER_POLL_INTERVAL_MS = 10;

export interface FilterProcessIdentity {
  readonly pid: number;
  readonly startTime: number;
}

export interface PostEofStallFilter {
  readonly filterPath: string;
  readonly pidPath: string;
  readonly eofPath: string;
}

export async function createPostEofStallFilter(
  tempDir: string,
): Promise<PostEofStallFilter> {
  const filterPath = path.join(tempDir, "post-eof-stall-filter");
  const pidPath = path.join(tempDir, "post-eof-stall-filter.pid");
  const eofPath = path.join(tempDir, "post-eof-stall-filter.eof");
  await writeFile(
    filterPath,
    `#!${process.execPath}
import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(pidPath)}, String(process.pid) + "\\n");
for await (const _chunk of Bun.stdin.stream()) {
}
await appendFile(${JSON.stringify(eofPath)}, String(process.pid) + "\\n");
process.on("SIGTERM", () => {});
await new Promise<void>(() => {});
`,
  );
  await chmod(filterPath, 0o700);
  return { filterPath, pidPath, eofPath };
}

export async function readFilterProcessIdentity(
  pid: number,
): Promise<FilterProcessIdentity | null> {
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    const commEnd = stat.lastIndexOf(") ");
    if (commEnd <= 0) return null;
    const fields = stat
      .slice(commEnd + 2)
      .trim()
      .split(/\s+/);
    const startTime = Number(fields[19]);
    if (!Number.isSafeInteger(startTime)) return null;
    return { pid, startTime };
  } catch {
    return null;
  }
}

export async function waitForRecordedFilterPids(
  pidPath: string,
  expected = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pids = [
        ...new Set(
          (await Bun.file(pidPath).text())
            .split(/\s+/)
            .map(Number)
            .filter((pid) => Number.isSafeInteger(pid) && pid > 1),
        ),
      ];
      if (pids.length >= expected) return pids;
    } catch {
      // The two independent filters publish their identities separately.
    }
    await Bun.sleep(FILTER_POLL_INTERVAL_MS);
  }
  throw new Error(`expected ${expected} filter PIDs in ${pidPath}`);
}

export async function captureFilterProcessIdentities(
  pids: readonly number[],
): Promise<FilterProcessIdentity[]> {
  const identities: FilterProcessIdentity[] = [];
  for (const pid of pids) {
    const identity = await readFilterProcessIdentity(pid);
    if (!identity) throw new Error(`filter process ${pid} exited too early`);
    identities.push(identity);
  }
  return identities;
}

export async function waitForFilterProcessesGone(
  identities: readonly FilterProcessIdentity[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let allGone = true;
    for (const identity of identities) {
      const current = await readFilterProcessIdentity(identity.pid);
      if (!current) continue;
      if (current.startTime !== identity.startTime) {
        throw new Error(`filter process ${identity.pid} was reused`);
      }
      allGone = false;
    }
    if (allGone) return;
    if (Date.now() >= deadline) break;
    await Bun.sleep(FILTER_POLL_INTERVAL_MS);
  }
  throw new Error(
    `post-exit filter cleanup did not finish within ${timeoutMs}ms`,
  );
}

export async function forceFilterProcessesGone(
  identities: readonly FilterProcessIdentity[],
): Promise<void> {
  for (const identity of identities) {
    if (identity.pid === process.pid || identity.pid <= 1) continue;
    const current = await readFilterProcessIdentity(identity.pid);
    if (!current) continue;
    if (current.startTime !== identity.startTime) {
      throw new Error(
        `filter process ${identity.pid} was reused during emergency cleanup`,
      );
    }
    try {
      process.kill(identity.pid, "SIGKILL");
    } catch {
      // The normal cleanup path may already have reaped this filter.
    }
  }
  await waitForFilterProcessesGone(identities);
}
