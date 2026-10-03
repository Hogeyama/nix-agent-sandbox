import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  Approvals,
  handleConnection,
  SOCKET_COMMAND_BYTES,
  SOCKET_COMMAND_TIMEOUT_MS,
} from "./approval.ts";

// The connection handler, without binding a Unix socket: srt blocks AF_UNIX
// inside a strait sandbox, where approval_test.ts skips its socket tests.
class Connection extends EventEmitter {
  response: string[] = [];
  destroyed = false;

  end(data: string) {
    this.response.push(data);
    return this;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  receive(data: string | Buffer) {
    this.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
}

const request = {
  method: "POST",
  url: "https://github.com/a/b",
  reason: "push",
};

function setup() {
  const approvals = new Approvals({
    id: "k3f9",
    cwd: "/w",
    command: ["claude"],
    startedAt: 0,
  });
  const connection = new Connection();
  handleConnection(approvals, connection as unknown as Socket);
  return { approvals, connection };
}

describe("approval connection handler", () => {
  test("a fragmented single command approves exactly once", async () => {
    const { approvals, connection } = setup();
    const held = approvals.hold(request);
    const pending = approvals.list()[0];
    const command = `${JSON.stringify({ op: "decide", id: pending?.id, approve: true })}\n`;
    try {
      connection.receive(command.slice(0, 10));
      expect(connection.response).toEqual([]);
      connection.receive(command.slice(10));
      expect(connection.response).toEqual(['{"ok":true}\n']);
      expect(await held).toEqual({ action: "allow" });
    } finally {
      connection.destroy();
      approvals.close();
    }
  });

  test("two commands in one chunk fail closed", async () => {
    const { approvals, connection } = setup();
    const held = approvals.hold(request);
    const command = `${JSON.stringify({ op: "decide", id: approvals.list()[0]?.id, approve: true })}\n`;
    try {
      connection.receive(command + command);
      expect(connection.response).toEqual(['{"error":"bad request"}\n']);
      expect(approvals.list()).toHaveLength(1);
      approvals.close();
      expect((await held).action).toBe("deny");
    } finally {
      connection.destroy();
      approvals.close();
    }
  });

  test("a second data event never dispatches another command", async () => {
    const { approvals, connection } = setup();
    const held = approvals.hold(request);
    const command = `${JSON.stringify({ op: "decide", id: approvals.list()[0]?.id, approve: true })}\n`;
    try {
      connection.receive('{"op":"list"}\n');
      connection.receive(command);
      expect(connection.response).toHaveLength(1);
      expect(approvals.list()).toHaveLength(1);
      approvals.close();
      expect((await held).action).toBe("deny");
    } finally {
      connection.destroy();
      approvals.close();
    }
  });

  test("the limit counts UTF-8 bytes and applies across chunks", () => {
    const { approvals, connection } = setup();
    try {
      connection.receive("é".repeat(SOCKET_COMMAND_BYTES / 2));
      expect(connection.destroyed).toBe(false);
      connection.receive("x");
      expect(connection.destroyed).toBe(true);
      expect(connection.response).toEqual([]);
    } finally {
      connection.destroy();
      approvals.close();
    }
  });

  test("invalid UTF-8 and JSON are rejected before dispatch", () => {
    for (const command of [
      Buffer.from([0xff, 0x0a]),
      "{broken}\n",
      "null\n",
      "[]\n",
    ]) {
      const { approvals, connection } = setup();
      try {
        connection.receive(command);
        expect(connection.response).toEqual(['{"error":"bad request"}\n']);
      } finally {
        connection.destroy();
        approvals.close();
      }
    }
  });

  test(
    "a slow writer cannot reset the absolute deadline",
    async () => {
      const { approvals, connection } = setup();
      const held = approvals.hold(request);
      const started = performance.now();
      const writing = setInterval(() => connection.receive(" "), 50);
      try {
        await new Promise<void>((resolve) => connection.once("close", resolve));
        expect(performance.now() - started).toBeLessThan(
          SOCKET_COMMAND_TIMEOUT_MS + 2_000,
        );
        expect(connection.destroyed).toBe(true);
        expect(connection.response).toEqual([]);
        expect(approvals.list()).toHaveLength(1);
        approvals.close();
        expect((await held).action).toBe("deny");
      } finally {
        clearInterval(writing);
        connection.destroy();
        approvals.close();
      }
    },
    SOCKET_COMMAND_TIMEOUT_MS + 3_000,
  );
});
