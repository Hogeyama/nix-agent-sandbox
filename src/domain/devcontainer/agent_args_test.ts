import { expect, test } from "bun:test";
import { filterDevcontainerAgentArgs } from "./agent_args.ts";

test("codex keeps -c/--config pairs and drops everything else", () => {
  expect(
    filterDevcontainerAgentArgs("codex", [
      "-c",
      "model=o4-mini",
      "--config",
      "sandbox_mode=workspace-write",
      "--yolo",
      "some prompt text",
    ]),
  ).toEqual({
    kept: ["-c", "model=o4-mini", "--config", "sandbox_mode=workspace-write"],
    dropped: ["--yolo", "some prompt text"],
  });
});

test("codex keeps the joined -c=/--config= forms", () => {
  expect(
    filterDevcontainerAgentArgs("codex", [
      "-c=model=o4-mini",
      "--config=sandbox_mode=workspace-write",
      "--full-auto",
    ]),
  ).toEqual({
    kept: ["-c=model=o4-mini", "--config=sandbox_mode=workspace-write"],
    dropped: ["--full-auto"],
  });
});

test("codex drops a dangling -c with no value", () => {
  expect(filterDevcontainerAgentArgs("codex", ["--search", "-c"])).toEqual({
    kept: [],
    dropped: ["--search", "-c"],
  });
});

test("codex drops a -c whose value is another flag", () => {
  expect(
    filterDevcontainerAgentArgs("codex", ["-c", "--yolo", "--config", "-x"]),
  ).toEqual({
    kept: [],
    dropped: ["-c", "--yolo", "--config", "-x"],
  });
});

test("codex drops a -c whose value is not key=value", () => {
  expect(filterDevcontainerAgentArgs("codex", ["-c", "plain"])).toEqual({
    kept: [],
    dropped: ["-c", "plain"],
  });
});

test("codex drops a -c followed by -c and keeps the valid pair", () => {
  expect(filterDevcontainerAgentArgs("codex", ["-c", "-c", "a=b"])).toEqual({
    kept: ["-c", "a=b"],
    dropped: ["-c"],
  });
});

test("codex drops joined forms whose value is not key=value", () => {
  expect(
    filterDevcontainerAgentArgs("codex", ["-c=foo", "--config=-x=y", "-c=k=v"]),
  ).toEqual({
    kept: ["-c=k=v"],
    dropped: ["-c=foo", "--config=-x=y"],
  });
});

test("non-codex agents pass every arg through unchanged", () => {
  expect(
    filterDevcontainerAgentArgs("claude", ["--add-dir", "/x", "--yolo"]),
  ).toEqual({ kept: ["--add-dir", "/x", "--yolo"], dropped: [] });
});
