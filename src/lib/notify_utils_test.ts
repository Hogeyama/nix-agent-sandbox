import { expect, test } from "bun:test";
import {
  resolveNasCommand,
  resolveStandaloneNasCommand,
} from "./notify_utils.ts";

test("the packaged entry point wins over the binary inside the package", () => {
  // A Dev Container's initializeCommand is spawned by the IDE with none of
  // this process' environment, so it has to re-enter through the wrapper that
  // exports NAS_ASSET_DIR rather than the binary the wrapper exec's.
  expect(
    resolveStandaloneNasCommand(
      { NAS_BIN_PATH: "/nix/store/abc-nas/bin/nas" },
      "/nix/store/abc-nas/share/nas/nas",
    ),
  ).toEqual({ execPath: "/nix/store/abc-nas/bin/nas", prefix: [] });
});

test("the packaged entry point also wins over a script runner", () => {
  expect(
    resolveStandaloneNasCommand(
      { NAS_BIN_PATH: "/nix/store/abc-nas/bin/nas" },
      "/usr/bin/bun",
    ),
  ).toEqual({ execPath: "/nix/store/abc-nas/bin/nas", prefix: [] });
});

test("a relative or blank NAS_BIN_PATH is not trusted as an entry point", () => {
  for (const value of ["", "   ", "nas", "./nas"])
    expect(
      resolveStandaloneNasCommand({ NAS_BIN_PATH: value }, "/opt/nas/bin/nas")
        .execPath,
    ).toBe("/opt/nas/bin/nas");
});

test("a compiled binary with no packaging hint is used as it is", () => {
  expect(resolveStandaloneNasCommand({}, "/opt/nas/bin/nas")).toEqual({
    execPath: "/opt/nas/bin/nas",
    prefix: [],
  });
});

test("a script runner re-enters through the source entry point", () => {
  const resolved = resolveStandaloneNasCommand({}, "/usr/bin/bun");
  expect(resolved.execPath).toBe("/usr/bin/bun");
  expect(resolved.prefix[0]).toBe("run");
  expect(resolved.prefix[1]).toEndWith("/main.ts");
});

test("an immediate child re-enters through the binary it inherits env from", () => {
  // The packaged entry point re-extracts the whole bundle to /tmp on every
  // invocation; a child spawned while this process is alive (a notification's
  // Approve action, say) inherits NAS_ASSET_DIR and, for the bundled build,
  // gets LD_* restored by cleanup_env.so's self re-exec detection — the inner
  // binary is both sufficient and free.
  expect(resolveNasCommand("/tmp/nas.XXXXXX/orig/nas")).toEqual({
    execPath: "/tmp/nas.XXXXXX/orig/nas",
    prefix: [],
  });
});
