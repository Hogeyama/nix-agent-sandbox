import { expect, test } from "bun:test";
import { extractLogFile } from "./log_file.ts";

test("log-file belongs only to the nas control prefix", () => {
  expect(
    extractLogFile(["--verbose", "--log-file", "/tmp/nas.log", "claude-acp"]),
  ).toEqual({ args: ["--verbose", "claude-acp"], logFile: "/tmp/nas.log" });
  expect(extractLogFile(["claude", "--log-file", "agent.log"])).toEqual({
    args: ["claude", "--log-file", "agent.log"],
    logFile: undefined,
  });
  expect(extractLogFile(["--", "--log-file", "agent.log"])).toEqual({
    args: ["--", "--log-file", "agent.log"],
    logFile: undefined,
  });
  expect(
    extractLogFile(["--name", "session", "--log-file=nas.log", "claude"]),
  ).toEqual({ args: ["--name", "session", "claude"], logFile: "nas.log" });
  expect(() => extractLogFile(["--log-file"])).toThrow("requires a path");
  expect(() => extractLogFile(["--log-file", "--quiet"])).toThrow(
    "requires a path",
  );
});
