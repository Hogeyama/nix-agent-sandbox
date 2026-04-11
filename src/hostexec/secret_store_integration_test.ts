import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDotEnv, resolveSecret, SecretStore } from "./secret_store.ts";

test("parseDotEnv: parses export and quoted values", () => {
  const parsed = parseDotEnv(
    `\n# comment\nexport FOO=bar\nBAR="baz"\nBAZ='qux'\n`,
  );
  expect(parsed).toEqual({ FOO: "bar", BAR: "baz", BAZ: "qux" });
});

test("parseDotEnv: handles escaped quotes in double-quoted values", () => {
  const parsed = parseDotEnv(
    `SECRET="value with \\"escaped\\" quotes"\nBACKSLASH="a\\\\b"\n`,
  );
  expect(parsed.SECRET).toEqual('value with "escaped" quotes');
  expect(parsed.BACKSLASH).toEqual("a\\b");
});

test("resolveSecret: reads env/file/dotenv/keyring sources", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-secret-store-"));
  try {
    const filePath = `${tmpDir}/secret.txt`;
    const dotenvPath = `${tmpDir}/.env`;
    await writeFile(filePath, "file-secret\n");
    await writeFile(dotenvPath, "TOKEN=dotenv-secret\n");

    expect(
      await resolveSecret("env:MY_SECRET", { MY_SECRET: "env-secret" }, () =>
        Promise.resolve(null),
      ),
    ).toEqual("env-secret");
    expect(
      await resolveSecret(`file:${filePath}`, {}, () => Promise.resolve(null)),
    ).toEqual("file-secret");
    expect(
      await resolveSecret(`dotenv:${dotenvPath}#TOKEN`, {}, () =>
        Promise.resolve(null),
      ),
    ).toEqual("dotenv-secret");
    expect(
      await resolveSecret(
        "keyring:svc/account",
        {},
        (service: string, account: string) =>
          Promise.resolve(`${service}:${account}`),
      ),
    ).toEqual("svc:account");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("SecretStore: caches values and enforces required secrets", async () => {
  let calls = 0;
  const store = new SecretStore(
    {
      token: { from: "env:TOKEN", required: true },
      optional: { from: "env:OPTIONAL", required: false },
      keyring: { from: "keyring:svc/account", required: true },
    },
    {
      env: { TOKEN: "abc" },
      keyringResolver: () => {
        calls += 1;
        return Promise.resolve("from-keyring");
      },
    },
  );

  expect(await store.require("token")).toEqual("abc");
  expect(await store.get("optional")).toEqual(null);
  expect(await store.require("keyring")).toEqual("from-keyring");
  expect(await store.require("keyring")).toEqual("from-keyring");
  expect(calls).toEqual(1);
  await expect(store.require("missing")).rejects.toThrow("Unknown secret");
});

test("SecretStore: rejects missing required secret", async () => {
  const store = new SecretStore(
    {
      token: { from: "env:TOKEN", required: true },
    },
    { env: {} },
  );
  await expect(store.require("token")).rejects.toThrow("Required secret");
});
