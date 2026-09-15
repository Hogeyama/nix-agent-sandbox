import { expect, test } from "bun:test";
import {
  parseDevcontainerArgs,
  parseDevcontainerSupervisorArgs,
} from "./devcontainer_args.ts";

test("parses public actions with action-specific options", () => {
  expect(
    parseDevcontainerArgs(["init", "--profile", "claude"], "/work"),
  ).toEqual({
    action: "init",
    workspace: "/work",
    profile: "claude",
  });
  expect(
    parseDevcontainerArgs(["status", "--workspace", "repo", "--json"], "/work"),
  ).toEqual({ action: "status", workspace: "/work/repo", json: true });
});

test("rejects options outside their action and unsupported agent args", () => {
  expect(() =>
    parseDevcontainerArgs(["up", "--profile", "other"], "/work"),
  ).toThrow("--profile is only supported by init");
  expect(() => parseDevcontainerArgs(["init", "--json"], "/work")).toThrow(
    "--json is not supported by init",
  );
  expect(() =>
    parseDevcontainerArgs(["up", "--", "--danger"], "/work"),
  ).toThrow("does not accept agent arguments");
});

test("rejects missing values, unknown options, and multiple actions", () => {
  expect(() => parseDevcontainerArgs(["up", "--workspace"], "/work")).toThrow(
    "--workspace requires a value",
  );
  expect(() => parseDevcontainerArgs(["up", "--wat"], "/work")).toThrow(
    "unknown devcontainer option",
  );
  expect(() => parseDevcontainerArgs(["up", "down"], "/work")).toThrow(
    "exactly one devcontainer action",
  );
});

test("internal supervisor parser accepts only its exact argv", () => {
  expect(
    parseDevcontainerSupervisorArgs([
      "_supervise",
      "--workspace",
      "/work",
      "--session",
      "dc_123",
      "--deadline-at",
      "123456",
    ]),
  ).toEqual({ workspace: "/work", sessionId: "dc_123", deadlineAt: 123456 });
  expect(() =>
    parseDevcontainerSupervisorArgs(["_supervise", "--workspace", "/work"]),
  ).toThrow("requires workspace, session, and deadline");
  expect(() =>
    parseDevcontainerSupervisorArgs([
      "_supervise",
      "--workspace",
      "/work",
      "--session",
      "dc_123",
      "--deadline-at",
      "later",
    ]),
  ).toThrow("positive integer");
});
