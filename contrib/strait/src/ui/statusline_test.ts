import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { isSessionId, newSessionId, sessionInfo } from "../core/session.ts";
import { findStatusLine, wrapStatusLine } from "./statusline.ts";

const files = (m: Record<string, unknown>) => (path: string) =>
  path in m ? JSON.stringify(m[path]) : undefined;

describe("findStatusLine", () => {
  const env = { HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude" };
  test("project local, then project, then user", () => {
    const all = {
      "/w/.claude/settings.local.json": { statusLine: { command: "local" } },
      "/w/.claude/settings.json": { statusLine: { command: "project" } },
      "/h/.claude/settings.json": { statusLine: { command: "user" } },
    };
    expect(findStatusLine("/w", env, files(all))?.command).toBe("local");
    const { "/w/.claude/settings.local.json": _, ...rest } = all;
    expect(findStatusLine("/w", env, files(rest))?.command).toBe("project");
    expect(
      findStatusLine(
        "/w",
        env,
        files({ "/h/.claude/settings.json": all["/h/.claude/settings.json"] }),
      )?.command,
    ).toBe("user");
  });
  test("a file without a status line, or broken, is passed over", () => {
    const read = (p: string) =>
      p === "/w/.claude/settings.local.json"
        ? "{"
        : p === "/w/.claude/settings.json"
          ? "{}"
          : JSON.stringify({ statusLine: { command: "user" } });
    expect(findStatusLine("/w", env, read)?.command).toBe("user");
  });
  test("CLAUDE_CONFIG_DIR is the user directory when set", () => {
    const read = files({
      "/c/settings.json": { statusLine: { command: "c" } },
    });
    expect(
      findStatusLine("/w", { CLAUDE_CONFIG_DIR: "/c" }, read)?.command,
    ).toBe("c");
  });
  test("none anywhere", () => {
    expect(findStatusLine("/w", env, () => undefined)).toBeUndefined();
  });
});

describe("wrapStatusLine", () => {
  const wrapper = "/s/strait-statusline";
  test("claude gets --settings first, and the original command in the env", () => {
    const w = wrapStatusLine(
      ["/bin/claude", "--continue"],
      { type: "command", command: "~/.claude/sl.sh", padding: 1 },
      wrapper,
    );
    expect(w.command[0]).toBe("/bin/claude");
    expect(w.command[1]).toBe("--settings");
    expect(JSON.parse(w.command[2] as string)).toEqual({
      statusLine: { type: "command", command: wrapper, padding: 1 },
    });
    expect(w.command.slice(3)).toEqual(["--continue"]);
    expect(w.env).toEqual({ STRAIT_STATUSLINE_INNER: "~/.claude/sl.sh" });
  });
  test("no status line of one's own: just the session", () => {
    const w = wrapStatusLine(["claude"], undefined, wrapper);
    expect(w.command.length).toBe(3);
    expect(w.env).toEqual({});
  });
  test("anything but claude is left alone", () => {
    const w = wrapStatusLine(["bash", "-c", "claude"], undefined, wrapper);
    expect(w).toEqual({ command: ["bash", "-c", "claude"], env: {} });
  });
});

describe("strait-statusline", () => {
  const script = resolve(import.meta.dir, "..", "..", "strait-statusline");
  const run = (env: Record<string, string>) =>
    spawnSync("sh", [script], {
      input: '{"model":{"display_name":"Opus"}}',
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    }).stdout;
  test("the session, then the original status line reading the same input", () => {
    expect(
      run({
        STRAIT_SESSION: "k3f9",
        STRAIT_STATUSLINE_INNER:
          'sed \'s/.*display_name":"\\([^"]*\\).*/model=\\1/\'',
      }),
    ).toBe("[strait:k3f9] model=Opus");
  });
  test("just the session without an original", () => {
    expect(run({ STRAIT_SESSION: "k3f9" })).toBe("[strait:k3f9] \n");
  });
});

describe("session IDs", () => {
  test("generated IDs are short, unambiguous and valid names", () => {
    for (let i = 0; i < 50; i++) {
      const id = newSessionId();
      expect(id).toMatch(/^[2-9a-km-z]{4}$/);
      expect(isSessionId(id)).toBe(true);
    }
  });
  test("names", () => {
    for (const ok of ["release", "a", "my-work_2"]) {
      expect(isSessionId(ok)).toBe(true);
    }
    for (const bad of ["", "-a", "a-", "a/b", "a b", "a.b", "x".repeat(33)]) {
      expect(isSessionId(bad)).toBe(false);
    }
  });
  test("tmux pane is recorded when present", () => {
    const s = sessionInfo("k3f9", ["claude"], { TMUX_PANE: "%12" });
    expect(s).toMatchObject({
      id: "k3f9",
      command: ["claude"],
      tmuxPane: "%12",
    });
    expect(sessionInfo("k3f9", ["claude"], {}).tmuxPane).toBeUndefined();
  });
});
