import { expect, test } from "bun:test";
import * as path from "node:path";
import {
  extractWslDistroFromAuthority,
  parseWslDistroList,
  pickWslNasCommand,
  runNas,
  splitCommand,
} from "./nasCli.js";

const echoArgv = path.join(import.meta.dir, "testHelpers", "echoArgv.js");

test("splitCommand keeps a bare command as-is", () => {
  expect(splitCommand("nas")).toEqual({ cmd: "nas", prefixArgs: [] });
});

test("splitCommand splits a bridging command into cmd and fixed prefix args", () => {
  expect(splitCommand("wsl.exe -e /home/user/.nix-profile/bin/nas")).toEqual({
    cmd: "wsl.exe",
    prefixArgs: ["-e", "/home/user/.nix-profile/bin/nas"],
  });
});

test("splitCommand tolerates extra whitespace", () => {
  expect(splitCommand("  nas  ")).toEqual({ cmd: "nas", prefixArgs: [] });
});

test("splitCommand rejects an empty command", () => {
  expect(() => splitCommand("   ")).toThrow("nas-approval.nasPath is empty");
});

test("runNas passes prefix args ahead of the subcommand args", async () => {
  // "bun <echoArgv.js>" stands in for a bridging command like
  // "wsl.exe -e /path/to/nas": splitCommand's prefix args land before the
  // subcommand's own args.
  const out = await runNas(`bun ${echoArgv}`, ["network", "pending"]);
  expect(JSON.parse(out)).toEqual(["network", "pending"]);
});

test("parseWslDistroList strips the UTF-16 artifacts wsl.exe -l -q leaves behind", () => {
  // wsl.exe prints UTF-16LE; read as UTF-8 that arrives as a BOM followed by
  // a NUL byte after every character, including the newlines.
  const raw =
    "﻿U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000" +
    "M\u0000y\u0000N\u0000i\u0000x\u0000O\u0000S\u0000\r\u0000\n\u0000";
  expect(parseWslDistroList(raw)).toEqual(["Ubuntu", "MyNixOS"]);
});

test("parseWslDistroList drops blank lines", () => {
  expect(parseWslDistroList("Ubuntu\n\nMyNixOS\n\n")).toEqual([
    "Ubuntu",
    "MyNixOS",
  ]);
});

test("pickWslNasCommand returns the first distro whose probe succeeds", async () => {
  const tried = [];
  const command = await pickWslNasCommand(
    async () => ["Ubuntu", "MyNixOS"],
    async (cmd) => {
      tried.push(cmd);
      if (!cmd.includes("MyNixOS")) throw new Error("not found");
    },
  );
  expect(command).toBe("wsl.exe -d MyNixOS nas");
  expect(tried).toEqual(["wsl.exe -d Ubuntu nas", "wsl.exe -d MyNixOS nas"]);
});

test("pickWslNasCommand returns undefined when no distro's probe succeeds", async () => {
  const command = await pickWslNasCommand(
    async () => ["Ubuntu", "MyNixOS"],
    async () => {
      throw new Error("not found");
    },
  );
  expect(command).toBeUndefined();
});

test("pickWslNasCommand returns undefined when there are no distros", async () => {
  const command = await pickWslNasCommand(
    async () => [],
    async () => {
      throw new Error("should not be called");
    },
  );
  expect(command).toBeUndefined();
});

// A real authority captured from a Windows + WSL2 (distro "NixOS") + Dev
// Container session: `dev-container+<hex>` where the hex is
// `{"hostPath":"\\\\wsl.localhost\\NixOS\\home\\hogeyama\\repo\\nix-agent-sandbox",...}`.
// This encoding is a Dev Containers internal, so it is only ever a
// best-effort distro *hint*: anything the extractor cannot decode must yield
// undefined and leave the caller to fall back to probing every distro. It is
// never a source for the workspace path — that comes from `vscode.Uri.path`.
const REAL_WSL_AUTHORITY =
  "dev-container+7b22686f737450617468223a225c5c5c5c77736c2e6c6f63616c686f73745c5c4e69784f535c5c686f6d655c5c686f676579616d615c5c7265706f5c5c6e69782d6167656e742d73616e64626f78222c226c6f63616c446f636b6572223a66616c73652c22636f6e66696746696c65223a7b22246d6962223a312c2270617468223a222f686f6d652f686f676579616d612f7265706f2f6e69782d6167656e742d73616e64626f782f2e646576636f6e7461696e65722f646576636f6e7461696e65722e6a736f6e222c22736368656d65223a227673636f64652d66696c65486f7374227d7d";

const authorityWithHostPath = (hostPath) =>
  `dev-container+${Buffer.from(JSON.stringify({ hostPath }), "utf8").toString("hex")}`;

test("extractWslDistroFromAuthority extracts the distro hint from a real WSL2 authority", () => {
  expect(extractWslDistroFromAuthority(REAL_WSL_AUTHORITY)).toBe("NixOS");
});

test("extractWslDistroFromAuthority also accepts the \\\\wsl$ UNC form", () => {
  expect(
    extractWslDistroFromAuthority(
      authorityWithHostPath("\\\\wsl$\\Ubuntu\\home\\user\\repo"),
    ),
  ).toBe("Ubuntu");
});

test("extractWslDistroFromAuthority returns undefined for a native-Linux devcontainer authority", () => {
  // hostPath has no WSL distro in it, so there is simply no hint to give.
  expect(
    extractWslDistroFromAuthority(authorityWithHostPath("/home/user/repo")),
  ).toBeUndefined();
});

test("extractWslDistroFromAuthority returns undefined when hostPath is absent or not a string", () => {
  expect(
    extractWslDistroFromAuthority(authorityWithHostPath(undefined)),
  ).toBeUndefined();
  expect(
    extractWslDistroFromAuthority(authorityWithHostPath(42)),
  ).toBeUndefined();
});

test("extractWslDistroFromAuthority returns undefined for a non-dev-container authority", () => {
  expect(extractWslDistroFromAuthority("wsl+Ubuntu")).toBeUndefined();
  expect(extractWslDistroFromAuthority("")).toBeUndefined();
  expect(extractWslDistroFromAuthority(undefined)).toBeUndefined();
});

test("extractWslDistroFromAuthority returns undefined for malformed hex or JSON", () => {
  expect(extractWslDistroFromAuthority("dev-container+zz")).toBeUndefined();
  expect(
    extractWslDistroFromAuthority(
      `dev-container+${Buffer.from("not json").toString("hex")}`,
    ),
  ).toBeUndefined();
});
