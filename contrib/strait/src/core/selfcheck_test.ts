import { expect, test } from "bun:test";
import { assertCredentialOverwritePatched } from "./selfcheck.ts";

test("installed srt must carry credential overwrite and closed failure patches", () => {
  expect(() => assertCredentialOverwritePatched()).not.toThrow();
});
test("missing overwrite hook or closed failure path prevents startup", () => {
  const manager = "return config.credentials.overwriteHeaders;";
  const tls = "credential header overwrite failed";
  expect(() => assertCredentialOverwritePatched("", tls)).toThrow(
    "patch is missing",
  );
  expect(() => assertCredentialOverwritePatched(manager, "")).toThrow(
    "patch is missing",
  );
});
