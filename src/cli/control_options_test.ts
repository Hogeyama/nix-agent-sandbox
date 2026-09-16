import { expect, test } from "bun:test";
import { extractControlOptions } from "./control_options.ts";

test("log-file belongs only to the nas control prefix", () => {
  expect(
    extractControlOptions([
      "--verbose",
      "--log-file",
      "/tmp/nas.log",
      "claude-acp",
    ]),
  ).toEqual({
    args: ["--verbose", "claude-acp"],
    logFile: "/tmp/nas.log",
    writeSessionId: undefined,
  });
  expect(extractControlOptions(["claude", "--log-file", "agent.log"])).toEqual({
    args: ["claude", "--log-file", "agent.log"],
    logFile: undefined,
    writeSessionId: undefined,
  });
  expect(extractControlOptions(["--", "--log-file", "agent.log"])).toEqual({
    args: ["--", "--log-file", "agent.log"],
    logFile: undefined,
    writeSessionId: undefined,
  });
  expect(
    extractControlOptions([
      "--name",
      "session",
      "--log-file=nas.log",
      "claude",
    ]),
  ).toEqual({
    args: ["--name", "session", "claude"],
    logFile: "nas.log",
    writeSessionId: undefined,
  });
  expect(() => extractControlOptions(["--log-file"])).toThrow(
    "requires a path",
  );
  expect(() => extractControlOptions(["--log-file", "--quiet"])).toThrow(
    "requires a path",
  );
});

test("write-session-id follows the same control-prefix rules", () => {
  expect(
    extractControlOptions(["--write-session-id", "/tmp/id", "claude-acp"]),
  ).toEqual({
    args: ["claude-acp"],
    logFile: undefined,
    writeSessionId: "/tmp/id",
  });
  expect(
    extractControlOptions(["--write-session-id=/tmp/id", "claude-acp"]),
  ).toEqual({
    args: ["claude-acp"],
    logFile: undefined,
    writeSessionId: "/tmp/id",
  });
  // プロファイル名より後ろはエージェントの引数領域。
  expect(
    extractControlOptions(["claude", "--write-session-id", "/tmp/id"]),
  ).toEqual({
    args: ["claude", "--write-session-id", "/tmp/id"],
    logFile: undefined,
    writeSessionId: undefined,
  });
  expect(() => extractControlOptions(["--write-session-id"])).toThrow(
    "requires a path",
  );
  expect(() =>
    extractControlOptions(["--write-session-id", "--quiet"]),
  ).toThrow("requires a path");
});

test("both control options can appear together, in either order", () => {
  expect(
    extractControlOptions([
      "--write-session-id",
      "/tmp/id",
      "--log-file",
      "/tmp/nas.log",
      "claude-acp",
    ]),
  ).toEqual({
    args: ["claude-acp"],
    logFile: "/tmp/nas.log",
    writeSessionId: "/tmp/id",
  });
  expect(
    extractControlOptions([
      "--log-file",
      "/tmp/nas.log",
      "--write-session-id",
      "/tmp/id",
      "claude-acp",
    ]),
  ).toEqual({
    args: ["claude-acp"],
    logFile: "/tmp/nas.log",
    writeSessionId: "/tmp/id",
  });
});
