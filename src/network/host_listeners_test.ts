import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isForwardableScope, readHostListeners } from "./host_listeners.ts";

const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function tcpLine(localHex: string, port: number, state = "0A"): string {
  return `   0: ${localHex}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 1 0000000000000000 100 0 0 10 0`;
}

async function withProc<T>(
  files: { tcp?: string[]; tcp6?: string[]; range?: string },
  fn: (procDir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-host-listeners-"));
  try {
    await mkdir(path.join(dir, "net"), { recursive: true });
    await mkdir(path.join(dir, "sys", "net", "ipv4"), { recursive: true });
    if (files.tcp) {
      await writeFile(
        path.join(dir, "net", "tcp"),
        [TCP_HEADER, ...files.tcp].join("\n"),
      );
    }
    if (files.tcp6) {
      await writeFile(
        path.join(dir, "net", "tcp6"),
        [TCP_HEADER, ...files.tcp6].join("\n"),
      );
    }
    if (files.range) {
      await writeFile(
        path.join(dir, "sys", "net", "ipv4", "ip_local_port_range"),
        files.range,
      );
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("listening ports are reported with the address scope they picked", async () => {
  await withProc(
    {
      tcp: [
        tcpLine("0100007F", 5432),
        tcpLine("00000000", 8080),
        tcpLine("0A00000A", 9000),
        tcpLine("0100007F", 4000, "01"),
      ],
      tcp6: [
        tcpLine("00000000000000000000000001000000", 6379),
        tcpLine("0000000000000000FFFF00000100007F", 8080),
      ],
      range: "32768\t60999\n",
    },
    async (procDir) => {
      expect(await readHostListeners(procDir)).toEqual([
        { containerPort: 5432, scope: "loopback" },
        { containerPort: 6379, scope: "loopback6" },
        { containerPort: 8080, scope: "any" },
        { containerPort: 9000, scope: "remote" },
      ]);
    },
  );
});

test("ports in the kernel's ephemeral range are not offered", async () => {
  await withProc(
    {
      tcp: [tcpLine("0100007F", 40_000), tcpLine("0100007F", 3000)],
      range: "32768 60999",
    },
    async (procDir) => {
      expect(
        (await readHostListeners(procDir)).map((l) => l.containerPort),
      ).toEqual([3000]);
    },
  );
});

test("a missing table or range falls back instead of failing", async () => {
  await withProc({ tcp: [tcpLine("0100007F", 3000)] }, async (procDir) => {
    expect(await readHostListeners(procDir)).toEqual([
      { containerPort: 3000, scope: "loopback" },
    ]);
  });
  await withProc({}, async (procDir) => {
    expect(await readHostListeners(procDir)).toEqual([]);
  });
});

test("only loopback and wildcard listeners can be reached by a forward", () => {
  expect(isForwardableScope("any")).toBe(true);
  expect(isForwardableScope("loopback")).toBe(true);
  expect(isForwardableScope("loopback6")).toBe(false);
  expect(isForwardableScope("remote")).toBe(false);
});
