# Materials for a bundled nas release

Download the binary archive, source/materials archive, and component inventory
for the **same tag and architecture** from the same Release. The binary archive
contains `nas` and `licenses/`. The source archive contains `components.json`,
`licenses/`, `sources/`, and `recipes/`. The component inventory connects each
component's version and origin to its license requirements, selected method,
and material paths. The reasons for those choices are in the
[bundled-license design](superpowers/specs/2026-09-23-bundled-nas-license-compliance-design.md).

## Find the corresponding sources

| Material | Location |
| --- | --- |
| nas source, build scripts, and lockfiles | `sources/nas-source.tar.gz` |
| dtach, glibc, and libfuse sources | `sources/native/` |
| Bun's TinyCC fork and embedded libtcc1 source | `sources/bun/tinycc.tar.gz`, `sources/bun/libtcc1.c` |
| MPL-2.0 crates compiled into Bun | `sources/cargo/` |
| Sources of packages included in the nas CLI and UI | `sources/javascript/` |
| Bun, its WebKit fork (JavaScriptCore), and its other dependencies | pinned upstream revisions in `recipes/upstream-sources.json` |
| Pkl and its GraalVM/OpenJDK runtime | pinned upstream revisions in `recipes/upstream-sources.json` |
| Nix build recipes and source pins | `recipes/` |
| Original license and copyright notices | `licenses/` |

Bun and Pkl are distributed the way their authors distribute them: this
Release carries their license and copyright notices, and their corresponding
sources are the public upstream revisions it names. `recipes/upstream-sources.json`
records Bun's repository, tag, and commit; the WebKit fork's commit; each
native dependency's repository, revision, and archive hash; the Node headers
and Rust sources Bun selects; and the Pkl, GraalVM, and LabsJDK revisions.
Bun's `Cargo.lock` and `bun.lock` files pin its crates and npm packages by
checksum and integrity.

As Bun's build definition states, its Linux build uses the
system ICU (for example `libicu-dev`); ICU's notices are in `licenses/`.

The JavaScript sources contain the packages selected by the CLI/UI build's
emitted inputs, including their original source files and package metadata.
The full development dependency cache is not included; install build tools
through the supplied lockfile using the ordinary commands below.

## Use a modified JavaScriptCore or TinyCC

Check out Bun and its WebKit fork at the revisions in
`recipes/upstream-sources.json`:

```sh
git clone https://github.com/oven-sh/bun && git -C bun checkout <bun commit>
git clone https://github.com/oven-sh/WebKit bun/vendor/WebKit
git -C bun/vendor/WebKit checkout <webkit commit>
```

Use Bun's `CONTRIBUTING.md` for toolchain prerequisites and upstream build
commands. Its “Building WebKit locally” section and
`scripts/build/deps/webkit.ts` describe building Bun with an editable WebKit
source tree in `vendor/WebKit` (or `BUN_WEBKIT_PATH`); make your changes there.
TinyCC's source and patch application are defined in
`scripts/build/deps/tinycc.ts` and `patches/tinycc/`; the TinyCC fork is also
in `sources/bun/tinycc.tar.gz`.

The upstream scripts build the runtime. The materials do not supply a
separate offline build system or promise a bit-for-bit identical executable.
Use the compiler and other external tools specified by upstream.

After building the modified Bun, unpack the nas source and use its normal
build commands from the nas source directory:

```sh
bun install --frozen-lockfile
bun run build-ui
bun scripts/compile.ts --runtime /absolute/path/to/modified-bun \
  --outfile /absolute/path/to/modified-nas
```

`--runtime` selects the executable used for compilation. To package it with
nas assets and native helpers, reuse the Nix bundle recipe from the nas source:

```sh
NAS_REBUILT_BINARY=/absolute/path/to/modified-nas \
  nix build --impure .#packages.x86_64-linux.bundled-with-runtime
```

Use `aarch64-linux` for that architecture. The ordinary `bundled` target uses
the pinned upstream runtime; use `bundled-with-runtime` for your modified one.

## Replace an extracted shared library

Choose an absolute path that does not exist yet:

```sh
./nas --extract /absolute/path/nas-unpacked
```

The extracted `bin/nas` launcher uses libraries in that directory. For each
affected executable (`nas`, `pkl`, `dtach`, or `nas-maskfs`), replace the library
in its `lib-<name>/` directory with an interface-compatible build for the same
architecture. When replacing glibc, keep its loader and libraries together
as a compatible set. Replace each copy if several executables use it.
Run `/absolute/path/nas-unpacked/bin/nas` to use those replacements.

For FUSE, replace `lib-nas-maskfs/libfuse3.so.4` and run the helper through
`share/nas/assets/maskfs/nas-maskfs` in the extracted directory. `LD_DEBUG=libs`
shows which libraries are loaded. Original notices remain under
`share/nas/assets/licenses/`.

## Maintain and verify release materials

`nix build .#release-inputs` derives Bun's native, Cargo, and npm sources
from its upstream definitions and lockfiles. Pkl's Gradle catalog selects
GraalVM, whose `common.json` selects LabsJDK. Nix fetches that source set
and creates its manifests in the store; no generated `*sources.json` is
checked into this repository and no separate regeneration command is needed.
The build reads notices from those sources and checks them against Bun's
lockfiles, but copies into the Release only the sources listed in the table
above. WebKit is fetched as a sparse checkout of `Source/JavaScriptCore`,
`Source/WTF`, and `Source/bmalloc`, the trees Bun compiles.

When updating Bun or Pkl, update the ordinary source pins and the aggregate
`runtimeSources.outputHash` in `nix/release/default.nix`. Set that hash to
`pkgs.lib.fakeHash`, build to obtain the actual hash, inspect the changed
inputs, and replace it with the reported value. The output hash covers both
the downloaded sources and their generated inventory. WebKit, ICU, Node
headers, and Rust retain their separate source pins there. License decisions
remain in the design and `nix/release/policy.json`.

Build `.#release-inputs` and `.#bundled` for the same source revision and
architecture, then stage and check them:

```sh
bun scripts/release.ts prepare --inputs /path/to/release-inputs \
  --binary /path/to/bundled-nas --out /path/to/new-stage --tag TAG
bash scripts/release/check_bundle.sh /path/to/new-stage/binary/nas \
  /path/to/new-report.txt
bun scripts/release.ts verify --stage /path/to/new-stage
```

The checks verify material references, hashes, matching embedded and outer
notices, ELF origins, and executable behavior. The bundle check exercises
replacement of extracted glibc and FUSE libraries. These checks do not
independently establish the legal sufficiency of every source collection or
prove a full modified-JSC build. Review concrete missing materials or license
issues before publication. CI runs the bundle checks on both architectures
and publishes the complete asset set through a draft Release.
