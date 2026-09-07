import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { HOSTEXEC_SCRIPT_CONTENT } from "./script.ts";

test("embedded hostexec content comes from the canonical executable asset", async () => {
  const asset = new URL("./hostexec", import.meta.url);
  expect(HOSTEXEC_SCRIPT_CONTENT).toBe(await readFile(asset, "utf8"));
  expect((await stat(asset)).mode & 0o111).not.toBe(0);
});
