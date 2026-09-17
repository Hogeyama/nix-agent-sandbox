import { expect, test } from "bun:test";
import { Cause } from "effect";
import { describeExitFailure } from "./runtime.ts";

test("a failed runtime is described by its message, not by a rendered cause", () => {
  // The serve entry describes a cause that was itself built from a described
  // one; rendering at both layers is what produced `Error: Error: ...`.
  const inner = describeExitFailure(
    Cause.fail(new Error("docker build exited with code 100")),
  );
  const outer = describeExitFailure(Cause.fail(new Error(inner)));
  expect(outer).toBe("docker build exited with code 100");
  expect(`devcontainer runtime failed: ${outer}`).not.toContain("Error:");
});

test("a defect has no message of its own and keeps the rendered cause", () => {
  const described = describeExitFailure(Cause.die(new Error("unexpected")));
  expect(described).toContain("unexpected");
});

test("a non-Error failure is stringified", () => {
  expect(describeExitFailure(Cause.fail("plain string"))).toBe("plain string");
});
