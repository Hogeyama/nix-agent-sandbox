import { describe, expect, test } from "bun:test";
import { resolveMaskSecrets } from "./mask_secrets.ts";

describe("resolveMaskSecrets", () => {
  test("resolves env: sources", async () => {
    const secrets = await resolveMaskSecrets([{ source: "env:MY_SECRET" }], {
      MY_SECRET: "s3cret-value",
    });
    expect(secrets).toEqual(["s3cret-value"]);
  });

  test("throws when secret is unavailable (fail-closed)", async () => {
    await expect(
      resolveMaskSecrets([{ source: "env:MISSING" }], {}),
    ).rejects.toThrow(/Required secret is unavailable/);
  });

  test("throws when resolved value is under 4 bytes", async () => {
    await expect(
      resolveMaskSecrets([{ source: "env:SHORT" }], { SHORT: "abc" }),
    ).rejects.toThrow(/at least 4 bytes/);
  });
});
