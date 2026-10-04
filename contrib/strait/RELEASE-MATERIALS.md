# Materials for a bundled strait release

Download the bundle archive, source/materials archive, and component inventory
for the **same tag and architecture** from the same Release
(`strait-vX.Y.Z_<system>.tar.gz`, `…-sources.tar.gz`, `…-components.json`).
The bundle archive contains the self-extracting `strait` and `licenses/`; the
same `licenses/` is inside the bundle and stays next to it after extraction.
The source archive contains `components.json`, `licenses/`, `sources/`, and
`recipes/`. The component inventory connects each component's version and
origin to its license requirements, selected method, and material paths. The
reasons for those choices are in the
[strait license design](../../docs/superpowers/specs/2026-10-04-strait-release-license-design.md),
which builds on the
[bundled-nas design](../../docs/superpowers/specs/2026-09-23-bundled-nas-license-compliance-design.md).

## Find the corresponding sources

| Material | Location |
| --- | --- |
| strait source, the sandbox-runtime patch, build scripts, and lockfiles | `sources/strait-source.tar.gz` (the whole repository) |
| glibc source | `sources/native/glibc.tar.xz` |
| Bun's TinyCC fork and embedded libtcc1 source | `sources/bun/tinycc.tar.gz`, `sources/bun/libtcc1.c` |
| MPL-2.0 crates compiled into Bun | `sources/cargo/` |
| Bun, its WebKit fork (JavaScriptCore), and its other dependencies | pinned upstream revisions in `recipes/upstream-sources.json` |
| sandbox-runtime, including the `apply-seccomp` source | the upstream tag in `recipes/upstream-sources.json` (`sandboxRuntime`) |
| npm packages | shipped unbundled in the bundle's `node_modules/` |
| Nix build recipes and source pins | `recipes/` |
| Original license and copyright notices | `licenses/` |

Bun is distributed the way its authors distribute it, as for bundled nas:
this Release carries its license and copyright notices, and its
corresponding source is the public upstream revision it names.
`licenses/bun/webkit/SOURCE-HEADERS.txt` and `licenses/bun/bun/SOURCE-HEADERS.txt`
reproduce the notices WebKit and Bun keep in individual source file headers.

The sandbox-runtime files strait patches end with a line
`// Modified for strait (nix-agent-sandbox) …` naming the patch, which is
`contrib/strait/patches/` in the strait source. `apply-seccomp` is built from
`vendor/seccomp-src` of the recorded sandbox-runtime tag and statically linked
with musl; `contrib/strait` in `flake.nix` (`srtApplySeccomp`) is the recipe.

## Install

```sh
tar -xzf strait-vX.Y.Z_x86_64-linux.tar.gz
./strait --extract ~/.local/share/strait
ln -sf ~/.local/share/strait/bin/strait ~/.local/bin/strait
```

Choose a directory that does not exist yet, outside `/tmp` and outside the
directories the sandbox may write. Extraction writes absolute paths into the
tree, so move it by extracting again. Run without extracting, the bundle only
answers `--version`.

## Use a modified JavaScriptCore or TinyCC

strait runs Bun as a separate, unmodified executable, `orig/bun` in the
extracted directory. To use a modified JavaScriptCore or TinyCC, build Bun at
the revisions in `recipes/upstream-sources.json`:

```sh
git clone https://github.com/oven-sh/bun && git -C bun checkout <bun commit>
git clone https://github.com/oven-sh/WebKit bun/vendor/WebKit
git -C bun/vendor/WebKit checkout <webkit commit>
```

Use Bun's `CONTRIBUTING.md` for toolchain prerequisites and build commands;
its “Building WebKit locally” section and `scripts/build/deps/webkit.ts`
describe building Bun with an editable WebKit tree in `vendor/WebKit`. TinyCC's
source and patches are defined in `scripts/build/deps/tinycc.ts` and
`patches/tinycc/`; the TinyCC fork is also in `sources/bun/tinycc.tar.gz`.

Then put the new executable in place of `orig/bun`. The launcher starts it
with the bundled glibc, so point it at the bundled loader first:

```sh
dir=~/.local/share/strait
patchelf --set-interpreter "$(patchelf --print-interpreter "$dir/orig/bun")" /path/to/modified-bun
install -m 755 /path/to/modified-bun "$dir/orig/bun"
"$dir/bin/strait" --version
```

The modified Bun must run with the bundled glibc (`lib-bun/`) or a
replacement for it (below). strait itself needs no rebuild.

## Replace an extracted shared library

In the extracted directory, replace a library in `lib-bun/` with an
interface-compatible build for the same architecture. When replacing glibc,
keep its loader and libraries together as a compatible set. `LD_DEBUG=libs`
shows which libraries are loaded.

## Maintain and verify release materials

`nix build .#strait-release-inputs` collects the materials, from the same Bun
inputs as nas's `.#release-inputs`. Every npm package in the bundle must be
listed with its reviewed license in `nix/release/strait-packages.json`, or the
build fails. Build `.#strait-release-inputs` and `.#strait-bundled` for the
same source revision and architecture, then stage and check them:

```sh
bun scripts/release.ts prepare --product strait --inputs /path/to/strait-release-inputs \
  --binary /path/to/strait-bundled --out /path/to/new-stage --tag strait-vX.Y.Z
bash scripts/release/check_strait_bundle.sh /path/to/new-stage/binary/strait \
  /path/to/new-report.txt
bun scripts/release.ts verify --stage /path/to/new-stage
```

The checks verify material references, hashes, matching embedded and outer
notices, ELF origins, and that the extracted bundle runs with a replaced
glibc and a replaced Bun executable. They do not prove a full modified-JSC
build. CI (`release-strait.yml`) runs them on both architectures and
publishes the complete asset set through a draft Release.
