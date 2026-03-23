import * as path from "@std/path";

export async function ensureDir(
  dirPath: string,
  mode = 0o700,
): Promise<void> {
  await Deno.mkdir(dirPath, { recursive: true, mode });
  await chmodIfSupported(dirPath, mode);
}

export async function chmodIfSupported(
  targetPath: string,
  mode: number,
): Promise<void> {
  try {
    await Deno.chmod(targetPath, mode);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotSupported)) {
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
  await Deno.writeTextFile(tempPath, JSON.stringify(value, null, 2) + "\n", {
    create: true,
    mode: 0o600,
  });
  await Deno.rename(tempPath, filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(filePath)) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export async function readJsonDir<T>(dirPath: string): Promise<T[]> {
  try {
    const items: T[] = [];
    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile) continue;
      const item = await readJsonFile<T>(path.join(dirPath, entry.name));
      if (item) items.push(item);
    }
    return items;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

export async function safeRemove(
  targetPath: string,
  options?: Deno.RemoveOptions,
): Promise<void> {
  try {
    await Deno.remove(targetPath, options);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function removeIfExists(targetPath: string): Promise<boolean> {
  if (!await pathExists(targetPath)) return false;
  await safeRemove(targetPath);
  return true;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await Deno.lstat(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function readPid(pidFile: string): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(pidFile);
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export async function isPidAlive(pid: number): Promise<boolean> {
  try {
    const output = await new Deno.Command("kill", {
      args: ["-0", String(pid)],
      stdout: "null",
      stderr: "null",
    }).output();
    return output.success;
  } catch {
    return false;
  }
}

export function defaultRuntimeDir(subsystem: string): string {
  const xdg = Deno.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, "nas", subsystem);
  }
  const uid = typeof Deno.uid === "function" ? Deno.uid() : "unknown";
  return path.join("/tmp", `nas-${uid}`, subsystem);
}
