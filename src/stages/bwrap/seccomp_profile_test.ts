import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BWRAP_SYSCALLS, bwrapSeccompProfile } from "./seccomp_profile.ts";

const vendored = new URL("../../docker/seccomp/", import.meta.url);

async function sha256(name: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(new URL(name, vendored)))
    .digest("hex");
}

// The profile is distributed as moby/profiles ships it, under its Apache-2.0
// license; changes belong in bwrapSeccompProfile(), not in the file. A new
// upstream revision changes these hashes together with
// DOCKER_DEFAULT_SECCOMP_REVISION.
test("the vendored Docker profile and its license are the upstream files", async () => {
  expect(await sha256("default.json")).toBe(
    "6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6",
  );
  expect(await sha256("LICENSE")).toBe(
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  );
});

test("the profile is Docker's default plus one rule allowing what bubblewrap needs", async () => {
  const upstream = JSON.parse(
    await readFile(new URL("default.json", vendored), "utf8"),
  );
  const profile = JSON.parse(bwrapSeccompProfile());

  expect(profile.defaultAction).toBe(upstream.defaultAction);
  expect(profile.syscalls.slice(0, -1)).toEqual(upstream.syscalls);
  expect(profile.syscalls.at(-1)).toMatchObject({
    names: [...BWRAP_SYSCALLS],
    action: "SCMP_ACT_ALLOW",
  });
  // An unconditional rule: no capability, argument, or arch filter.
  expect(Object.keys(profile.syscalls.at(-1)).sort()).toEqual([
    "action",
    "comment",
    "names",
  ]);
});
