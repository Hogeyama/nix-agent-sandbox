import * as path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";

export async function ensureDir(dirPath: string, mode = 0o700): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode });
  await chmodIfSupported(dirPath, mode);
}

export async function chmodIfSupported(
  targetPath: string,
  mode: number,
): Promise<void> {
  try {
    await chmod(targetPath, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTSUP") {
      throw error;
    }
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(tempPath, filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readJsonDir<T>(dirPath: string): Promise<T[]> {
  try {
    const items: T[] = [];
    for (const entry of await readdir(dirPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const item = await readJsonFile<T>(path.join(dirPath, entry.name));
      if (item) items.push(item);
    }
    return items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function safeRemove(
  targetPath: string,
  options?: { recursive?: boolean },
): Promise<void> {
  try {
    await rm(targetPath, { force: true, recursive: options?.recursive });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeIfExists(targetPath: string): Promise<boolean> {
  if (!(await pathExists(targetPath))) return false;
  await safeRemove(targetPath);
  return true;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readPid(pidFile: string): Promise<number | null> {
  try {
    const text = await readFile(pidFile, "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function isPidAlive(pid: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(["kill", "-0", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export function defaultRuntimeDir(subsystem: string): string {
  const xdg = process.env["XDG_RUNTIME_DIR"];
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, "nas", subsystem);
  }
  const uid = userInfo().uid;
  return path.join("/tmp", `nas-${uid}`, subsystem);
}
