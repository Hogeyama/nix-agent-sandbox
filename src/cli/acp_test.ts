import { expect, test } from "bun:test";
import type { Profile } from "../config/types.ts";
import { validateAcpInvocation } from "./acp.ts";

const profile = { mode: "acp" } as Profile;
test("ACP rejects protocol-consuming launch paths and extra arguments", () => {
  expect(() => validateAcpInvocation(profile, [], {}, false)).not.toThrow();
  expect(() =>
    validateAcpInvocation(profile, [], { NAS_INSIDE_DTACH: "1" }, false),
  ).toThrow("dtach");
  expect(() => validateAcpInvocation(profile, [], {}, true)).toThrow(
    "piped stdin",
  );
  expect(() => validateAcpInvocation(profile, ["--help"], {}, false)).toThrow(
    "CLI agent arguments",
  );
  expect(() =>
    validateAcpInvocation(
      { ...profile, worktree: { base: "HEAD", onCreate: "" } },
      [],
      {},
      false,
    ),
  ).toThrow("--worktree");
  expect(() =>
    validateAcpInvocation(
      { ...profile, mode: "terminal" },
      ["--help"],
      { NAS_INSIDE_DTACH: "1" },
      true,
    ),
  ).not.toThrow();
});
