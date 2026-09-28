import { open } from "node:fs/promises";
import { ensureDir } from "../lib/fs_utils.ts";

/** Serialize JSON read/modify/write across hook processes and UI actions.
 * Lock the stable directory inode, not a JSON file replaced by atomic rename.
 * The child and parent share an open file description; closing the parent fd
 * releases flock even after a crash, with no stale lockfile to recover.
 */
export async function withSessionStoreLock<A>(
  directory: string,
  operation: () => Promise<A>,
): Promise<A> {
  await ensureDir(directory);
  const handle = await open(directory, "r");
  try {
    const child = Bun.spawn(["flock", "-x", "-w", "2", "0"], {
      stdin: handle.fd,
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await child.exited) !== 0)
      throw new Error("session store lock unavailable within 2 seconds");
    return await operation();
  } finally {
    await handle.close();
  }
}
