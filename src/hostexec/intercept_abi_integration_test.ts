import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildInterceptArtifactsFromSource } from "./intercept_dev_build.ts";

/**
 * Highest glibc symbol version `hostexec_intercept.so` may require.
 *
 * The interceptor is LD_PRELOADed into processes the sandbox does not choose:
 * the image's own binaries, plus whatever /nix closures the host mounts in.
 * Those closures pin their own glibc, and one of them being older than the
 * build machine's is normal rather than exotic — a store path built against
 * glibc 2.32 is enough. When the .so asks for a newer symbol than the process
 * it lands in provides, the loader refuses to start that process at all
 * ("version `GLIBC_2.34' not found"), so the damage is not confined to
 * hostexec: every command under the preload dies.
 *
 * A native Zig build silently targets the *build* host's glibc, so this ceiling
 * regresses with no source change at all — a newer builder is enough. 2.17 is
 * the RHEL 7 floor and the conventional "runs anywhere" target.
 */
const MAX_GLIBC = { major: 2, minor: 17 };

const SHT_GNU_VERNEED = 0x6fff_fffe;

/**
 * Read the glibc versions an ELF object requires, from its `.gnu.version_r`.
 *
 * Parsed here rather than shelled out to `readelf` so the guard also holds
 * where binutils is not on PATH.
 */
function readVersionNeeds(elf: Buffer): string[] {
  expect(elf.subarray(0, 4).toString("latin1")).toBe("\x7fELF");
  expect(elf[4]).toBe(2); // ELFCLASS64
  expect(elf[5]).toBe(1); // ELFDATA2LSB

  const shoff = Number(elf.readBigUInt64LE(0x28));
  const shentsize = elf.readUInt16LE(0x3a);
  const shnum = elf.readUInt16LE(0x3c);

  const section = (index: number) => {
    const base = shoff + index * shentsize;
    return {
      type: elf.readUInt32LE(base + 0x04),
      offset: Number(elf.readBigUInt64LE(base + 0x18)),
      link: elf.readUInt32LE(base + 0x28),
    };
  };

  const verneedIndex = Array.from({ length: shnum }, (_, i) => i).find(
    (i) => section(i).type === SHT_GNU_VERNEED,
  );
  // Requiring no versioned symbol at all is a legal ELF, not a parse failure.
  if (verneedIndex === undefined) return [];

  const verneed = section(verneedIndex);
  const dynstr = section(verneed.link);
  const stringAt = (offset: number) => {
    const start = dynstr.offset + offset;
    return elf.subarray(start, elf.indexOf(0, start)).toString("latin1");
  };

  const names: string[] = [];
  for (let vn = verneed.offset; ; ) {
    const auxCount = elf.readUInt16LE(vn + 0x02);
    const auxOffset = elf.readUInt32LE(vn + 0x08);
    const nextOffset = elf.readUInt32LE(vn + 0x0c);
    for (let i = 0, vna = vn + auxOffset; i < auxCount; i++) {
      names.push(stringAt(elf.readUInt32LE(vna + 0x08)));
      vna += elf.readUInt32LE(vna + 0x0c);
    }
    if (nextOffset === 0) break;
    vn += nextOffset;
  }
  return names;
}

/**
 * Whether a version requirement is out of bounds for the floor.
 *
 * Anything named `GLIBC_*` that carries no parseable version counts as a
 * violation rather than as unclassifiable. The name that reaches this branch
 * in practice is `GLIBC_PRIVATE`, which is the strictest requirement glibc can
 * express: it is satisfied only by the exact glibc build the object linked
 * against, so treating it as "no version, no opinion" would wave through the
 * one need guaranteed to fail in a foreign /nix closure.
 */
function exceedsFloor(name: string): boolean {
  if (!name.startsWith("GLIBC_")) return false;
  const match = /^GLIBC_(\d+)\.(\d+)/.exec(name);
  if (match === null) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== MAX_GLIBC.major) return major > MAX_GLIBC.major;
  return minor > MAX_GLIBC.minor;
}

/**
 * Measured against this source tree's own build output, never through
 * `resolveInterceptLibPath`.
 *
 * That resolver honours `NAS_ASSET_DIR`, which points at the *installed* nas
 * whenever nas is developed inside a nas session — and other suites in this
 * run set it on `process.env`, which every later file in the same bun process
 * inherits. Reading through it makes this guard report on a shipped artifact
 * that the working tree cannot fix: it was doing exactly that, failing on the
 * pre-fix .so already installed at /opt/nas, while the corrected build.zig
 * next to it went ungraded.
 *
 * Building has to ignore `NAS_ASSET_DIR` for the same reason — hence
 * `FromSource` rather than `ForDev`. Otherwise the two halves disagree: the
 * build would skip while the read still lands on `zig-out/`, and the guard
 * would grade whatever an earlier build left there.
 */
const LIB_PATH = fileURLToPath(
  new URL("./intercept/zig-out/lib/libhostexec_intercept.so", import.meta.url),
);

await buildInterceptArtifactsFromSource();
const libBuilt = await Bun.file(LIB_PATH).exists();

test.skipIf(!libBuilt)(
  "hostexec_intercept.so requires no glibc symbol newer than the portability floor",
  async () => {
    const versions = readVersionNeeds(await readFile(LIB_PATH));

    expect({ lib: LIB_PATH, tooNew: versions.filter(exceedsFloor) }).toEqual({
      lib: LIB_PATH,
      tooNew: [],
    });
    // Guard the guard: a .so with no GLIBC_* need at all would satisfy the
    // check above while proving nothing about the parse.
    expect(versions.some((name) => name.startsWith("GLIBC_"))).toBe(true);
  },
);
