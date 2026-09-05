import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { GUIDE_SKILL_NAME } from "./content.ts";

async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();
const tmpDirs: string[] = [];

// DinD shared tmp が利用可能なら使う。なければ /tmp を使う。
const SHARED_TMP = process.env.NAS_DIND_SHARED_TMP;
const BASE_TMP = SHARED_TMP ?? "/tmp";
// Bind mount is only possible if SHARED_TMP is set (DinD sidecar has access)
// or if DOCKER_HOST is not set (host daemon can see this container's fs).
const canBindMount = SHARED_TMP !== undefined || !process.env.DOCKER_HOST;

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  );
});

test.skipIf(!dockerAvailable || !canBindMount)(
  "a read-only guide mount is visible at the container path",
  async () => {
    const hostDir = path.join(
      BASE_TMP,
      `nas-guide-int-${crypto.randomUUID().slice(0, 8)}`,
    );
    await mkdir(hostDir, { recursive: true });
    if (SHARED_TMP) await chmod(hostDir, 0o1777);
    tmpDirs.push(hostDir);
    const skillDir = path.join(hostDir, GUIDE_SKILL_NAME);
    await mkdir(skillDir, { recursive: true });
    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${GUIDE_SKILL_NAME}\n---\n`,
    );

    const target = `/home/nas/.agents/skills/${GUIDE_SKILL_NAME}`;
    const proc = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "-v",
        `${skillDir}:${target}:ro`,
        "alpine:3",
        "sh",
        "-c",
        `cat ${target}/SKILL.md && (touch ${target}/probe 2>/dev/null && echo WRITABLE || echo READONLY)`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain(`name: ${GUIDE_SKILL_NAME}`);
    expect(stdout).toContain("READONLY");
  },
);
