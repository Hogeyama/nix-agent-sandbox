import { expect, test } from "bun:test";
import { claimSessionId } from "./ownership.ts";

test("claimSessionId rejects an id that would escape the directory", () => {
  expect(() => claimSessionId("../sess_aaa", "/unused")).toThrow(
    /Invalid session/,
  );
  expect(() => claimSessionId("", "/unused")).toThrow(/Invalid session/);
});
