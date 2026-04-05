import { assertEquals, assertRejects } from "@std/assert";
import { parseDotEnv, resolveSecret, SecretStore } from "./secret_store.ts";

Deno.test("parseDotEnv: parses export and quoted values", () => {
  const parsed = parseDotEnv(
    `\n# comment\nexport FOO=bar\nBAR="baz"\nBAZ='qux'\n`,
  );
  assertEquals(parsed, { FOO: "bar", BAR: "baz", BAZ: "qux" });
});

Deno.test("parseDotEnv: handles escaped quotes in double-quoted values", () => {
  const parsed = parseDotEnv(
    `SECRET="value with \\"escaped\\" quotes"\nBACKSLASH="a\\\\b"\n`,
  );
  assertEquals(parsed.SECRET, 'value with "escaped" quotes');
  assertEquals(parsed.BACKSLASH, "a\\b");
});

Deno.test("resolveSecret: reads env/file/dotenv/keyring sources", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-secret-store-" });
  try {
    const filePath = `${tmpDir}/secret.txt`;
    const dotenvPath = `${tmpDir}/.env`;
    await Deno.writeTextFile(filePath, "file-secret\n");
    await Deno.writeTextFile(dotenvPath, "TOKEN=dotenv-secret\n");

    assertEquals(
      await resolveSecret(
        "env:MY_SECRET",
        { MY_SECRET: "env-secret" },
        () => Promise.resolve(null),
      ),
      "env-secret",
    );
    assertEquals(
      await resolveSecret(`file:${filePath}`, {}, () => Promise.resolve(null)),
      "file-secret",
    );
    assertEquals(
      await resolveSecret(
        `dotenv:${dotenvPath}#TOKEN`,
        {},
        () => Promise.resolve(null),
      ),
      "dotenv-secret",
    );
    assertEquals(
      await resolveSecret(
        "keyring:svc/account",
        {},
        (service, account) => Promise.resolve(`${service}:${account}`),
      ),
      "svc:account",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SecretStore: caches values and enforces required secrets", async () => {
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

  assertEquals(await store.require("token"), "abc");
  assertEquals(await store.get("optional"), null);
  assertEquals(await store.require("keyring"), "from-keyring");
  assertEquals(await store.require("keyring"), "from-keyring");
  assertEquals(calls, 1);
  await assertRejects(() => store.require("missing"), Error, "Unknown secret");
});

Deno.test("SecretStore: rejects missing required secret", async () => {
  const store = new SecretStore({
    token: { from: "env:TOKEN", required: true },
  }, { env: {} });
  await assertRejects(() => store.require("token"), Error, "Required secret");
});
