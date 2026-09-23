#!/usr/bin/env python3
"""Assemble pinned Nix/Bun license inputs and validate their source identities.

The Nix expression supplies fixed-output source paths. This script reads those
paths in a network-free derivation and records every byte it puts in the output.
"""

import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib


NOTICE_NAMES = ("license", "copying", "notice", "authors")


def safe_member(member: tarfile.TarInfo) -> bool:
    path = Path(member.name)
    return (
        not path.is_absolute()
        and ".." not in path.parts
        and member.isfile()
        and not member.issym()
        and not member.islnk()
    )


def extract_notices(archive: Path, relatives: list[str]) -> dict[str, bytes]:
    wanted = set(relatives)
    found: dict[str, bytes] = {}
    with tarfile.open(archive, "r:*") as stream:
        for member in stream:
            if not safe_member(member):
                continue
            relative = "/".join(Path(member.name).parts[1:])
            if relative not in wanted:
                continue
            if relative in found:
                raise ValueError(f"{archive}: duplicate notice {relative}")
            body = stream.extractfile(member)
            assert body is not None
            found[relative] = body.read()
    if found.keys() != wanted or any(not body for body in found.values()):
        raise ValueError(f"{archive}: missing or empty notices: {sorted(wanted - found.keys())}")
    return found


def extract_notice(archive: Path, relative: str) -> bytes:
    return extract_notices(archive, [relative])[relative]


def top_level_notices(archive: Path) -> list[str]:
    with tarfile.open(archive, "r:*") as stream:
        return sorted(
            {
                Path(member.name).parts[1]
                for member in stream
                if safe_member(member)
                and len(Path(member.name).parts) == 2
                and any(word in Path(member.name).name.lower() for word in NOTICE_NAMES)
            }
        )


def verify_bun_pins(config: dict) -> None:
    bun = next(item for item in config["bunSources"] if item["id"] == "bun")
    archive = Path(bun["path"])
    manifest = json.loads(extract_notice(archive, "package.json"))
    if manifest["version"] != config["bunVersion"]:
        raise ValueError("Bun version differs from reviewed source pins")
    webkit_definition = extract_notice(archive, "scripts/build/deps/webkit.ts").decode()
    if config["webkitRevision"] not in webkit_definition:
        raise ValueError("WebKit revision differs from Bun's build definition")
    for item in config["bunSources"]:
        if item["id"] == "bun":
            continue
        definition = extract_notice(archive, f"scripts/build/deps/{item['id']}.ts").decode()
        if item["revision"] not in definition or item["repo"] not in definition:
            raise ValueError(f"{item['id']}: source revision/repository differs from Bun build definition")
    lock = tomllib.loads(extract_notice(archive, "Cargo.lock").decode())
    expected = {
        (item["name"], item["version"]): base64.b64decode(item["hash"].removeprefix("sha256-")).hex()
        for item in config["cargo"]
    }
    actual = {
        (item["name"], item["version"]): item["checksum"]
        for item in lock["package"]
        if item.get("source", "").startswith("registry+")
    }
    if actual != expected:
        raise ValueError("Cargo registry pins differ from the distributed Bun source's Cargo.lock")


def add_file(root: Path, relative: str, source: Path | bytes) -> str:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(source, bytes):
        target.write_bytes(source)
    else:
        shutil.copyfile(source, target)
    if not target.is_file() or target.stat().st_size == 0:
        raise ValueError(f"empty required material: {relative}")
    return relative


def archive_suffix(source: Path) -> str:
    for suffix in (".tar.xz", ".tar.gz", ".tgz", ".zip", ".crate"):
        if source.name.endswith(suffix):
            return suffix
    raise ValueError(f"unrecognized source archive suffix: {source}")


def archive_tree(root: Path, relative: str, source: Path, *, exclude: tuple[str, ...] = ()) -> str:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    compressor = ["xz", "-T0", "-6"] if relative.endswith(".tar.xz") else ["gzip", "-n"]
    with target.open("wb") as output:
        tar = subprocess.Popen(
            ["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0",
             "--exclude=.git",
             *(f"--exclude={name}" for name in exclude), "-C", str(source), "-cf", "-", "."],
            stdout=subprocess.PIPE,
        )
        assert tar.stdout is not None
        compressed = subprocess.run(compressor, stdin=tar.stdout, stdout=output, check=False)
        tar.stdout.close()
        if tar.wait() != 0 or compressed.returncode != 0:
            raise ValueError(f"could not archive source tree: {source}")
    if target.stat().st_size == 0:
        raise ValueError(f"empty source tree: {source}")
    return relative


def component(id_: str, version: str, license_: str, origin: str, requirements: list[str],
              notices: list[str], sources: list[str]) -> dict:
    return {
        "id": id_,
        "version": version,
        "license": license_,
        "origin": origin,
        "requirements": requirements,
        "decision": ("Provide original notices and corresponding source under the same Release; see "
                     if sources else "Provide original notices; no source obligation; see ")
                    + (", ".join(requirements) or "the component license"),
        "notices": notices,
        "sources": sources,
    }


def collect_archive(root: Path, entry: dict, policy: dict, prefix: str = "bun") -> dict:
    id_ = entry["id"]
    archive = Path(entry["path"])
    if not archive.is_file():
        raise ValueError(f"missing pinned archive: {archive}")
    source_name = f"sources/{prefix}/{id_}{archive_suffix(archive)}"
    source_path = add_file(root, source_name, archive)
    notice_files = sorted(set(top_level_notices(archive) + policy.get("noticeFiles", [])))
    notices = [
        add_file(root, f"licenses/{prefix}/{id_}/{name}", extract_notice(archive, name))
        for name in notice_files
    ]
    if not notices:
        raise ValueError(f"{id_}: no original permission/copyright notice found")
    return component(
        f"{prefix}-{id_}", entry["revision"], policy["license"],
        entry["origin"], policy["requirements"], notices, [source_path],
    )


def copy_recipes(root: Path, cfg: dict) -> list[str]:
    paths = []
    for recipe in cfg["recipes"]:
        source = Path(recipe["path"])
        if source.is_dir():
            paths.append(archive_tree(root, f"recipes/{recipe['id']}.tar.gz", source))
        else:
            paths.append(add_file(root, f"recipes/{recipe['id']}{source.suffix}", source))
    return paths


def collect_javascript(root: Path, cfg: dict) -> list[dict]:
    result = []
    for target in ("cli", "ui"):
        base = Path(cfg["javascript"][target])
        manifest = json.loads((base / "components.json").read_text())
        for item in manifest["components"]:
            new = dict(item)
            new["id"] = f"{target}-{item['id']}"
            new_notices = []
            for notice in item["notices"]:
                source = base / notice
                if source.is_symlink() or not source.is_file():
                    raise ValueError(f"unsafe or absent JavaScript notice: {source}")
                relative = Path(notice)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError(f"unsafe JavaScript notice path: {notice}")
                new_notices.append(add_file(root, f"licenses/javascript/{target}/{item['id']}/{relative}", source))
            new["notices"] = new_notices
            new["sources"] = []
            for source in item["sources"]:
                relative = Path(source)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError(f"unsafe JavaScript source path: {source}")
                directory = base / relative
                if directory.is_symlink() or not directory.is_dir():
                    raise ValueError(f"unsafe or absent JavaScript source: {directory}")
                new["sources"].append(archive_tree(
                    root, f"sources/javascript/{target}/{relative.name}.tar.gz", directory))
            result.append(new)
    return result


def elf_origins(raw_payload: Path, config: dict) -> tuple[dict[str, str], list[str]]:
    provenance = json.loads((raw_payload / "nix-bundle-elf-manifest.json").read_text())
    if provenance.get("schemaVersion") != 1:
        raise ValueError("unsupported raw bundle provenance schema")
    recorded = provenance["files"]
    origins = {}
    unknown = []
    for path in sorted(raw_payload.rglob("*")):
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                continue
        relative = path.relative_to(raw_payload).as_posix()
        evidence = recorded.get(relative)
        if not evidence:
            unknown.append(f"{relative} (no bundler provenance)")
            continue
        source = evidence.get("source")
        digest = evidence.get("sourceSha256")
        if evidence.get("generatedFrom") == "cleanup-env-source.ts":
            origins[relative] = "nix-bundle-elf-runtime"
            continue
        if not source or not Path(source).is_file() or hashlib.sha256(Path(source).read_bytes()).hexdigest() != digest:
            unknown.append(f"{relative} (source/hash mismatch)")
            continue
        source_path = Path(source)
        owner = next(
            (item["id"] for item in config["originRoots"] if source_path.is_relative_to(item["root"])),
            None,
        )
        if owner is None:
            owner = next(
                (item["id"] for item in config["originFiles"]
                 if source_path.is_relative_to(config["nasAssetsBase"])
                 and item["name"] == source_path.name
                 and hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest() == digest),
                None,
            )
        if owner is None:
            unknown.append(f"{relative} (unrecognized source {source})")
        else:
            origins[relative] = owner
    return origins, unknown


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text())
    fetched_root = Path(config["runtimeSources"])
    fetched = json.loads((fetched_root / "sources.json").read_text())
    if fetched["bunVersion"] != config["bunVersion"] or fetched["pklVersion"] != config["pklVersion"]:
        raise ValueError("Runtime sources differ from the bundled Bun/Pkl versions")
    for key in ("bunSources", "cargo", "npm", "pklSources"):
        config[key] = [dict(item, path=str(fetched_root / item["path"])) for item in fetched[key]]
    config["npmPins"] = str(fetched_root / "bun-npm-sources.json")
    root = Path(sys.argv[2])
    root.mkdir(parents=True, exist_ok=True)
    policy = config["policy"]["components"]
    components = []
    verify_bun_pins(config)
    runtime_versions = json.loads(subprocess.check_output(
        ["bun", "-e", "console.log(JSON.stringify({icu:process.versions.icu,unicode:process.versions.unicode}))"],
        text=True,
    ))
    if runtime_versions != {"icu": "78.3", "unicode": "17.0"}:
        raise ValueError(f"Bun runtime ICU/Unicode versions differ from source pin: {runtime_versions}")
    origins, unknown = elf_origins(Path(config["rawPayload"]), config)
    if unknown:
        raise ValueError("Unregistered ELF paths: " + ", ".join(unknown))
    shipped = set(origins.values())

    for entry in config["bunSources"]:
        components.append(collect_archive(root, entry, policy[entry["id"]]))

    for entry in config["native"]:
        id_ = entry["id"]
        # A shared library the bundler may resolve is distributed only when
        # the payload actually contains it.
        if entry.get("payloadOnly") and id_ not in shipped:
            continue
        source = Path(entry["path"])
        with_source = entry.get("source", True)
        sources = []
        if source.is_dir():
            if with_source:
                sources.append(archive_tree(root, f"sources/native/{id_}.tar.gz", source))
            notice_data = {name: (source / name).read_bytes() for name in entry["notices"]}
        else:
            if with_source:
                sources.append(add_file(root, f"sources/native/{id_}{archive_suffix(source)}", source))
            notice_data = {name: extract_notice(source, name) for name in entry["notices"]}
        notices = [
            add_file(root, f"licenses/native/{id_}/{Path(name).name}", data)
            for name, data in notice_data.items()
        ]
        components.append(component(id_, entry["version"], entry["license"], entry["origin"],
                                    entry["requirements"], notices, sources))

    for entry in config["pklSources"]:
        archive = Path(entry["path"])
        source_rel = add_file(root, f"sources/native/{entry['id']}.tar.gz", archive)
        terms = policy[entry["id"]]
        notice_files = list(terms["noticeFiles"])
        if entry["id"] == "pkl-openjdk-runtime":
            with tarfile.open(archive, "r:*") as source:
                notice_files.extend(
                    "/".join(Path(member.name).parts[1:]) for member in source
                    if safe_member(member) and len(Path(member.name).parts) >= 6
                    and Path(member.name).parts[1] == "src"
                    and Path(member.name).parts[3:5] == ("share", "legal")
                )
        notice_files = sorted(set(notice_files))
        notice_data = extract_notices(archive, notice_files)
        notices = [
            add_file(root, f"licenses/native/{entry['id']}/{name}", notice_data[name])
            for name in notice_files
        ]
        components.append(component(entry["id"], entry["version"], terms["license"],
                                    entry["origin"], terms["requirements"], notices, [source_rel]))

    # This is the fixed hash of the official executable fetched by flake.nix
    # before mark_elf and autoPatchelf change it. Retain that identity in the
    # scoped Pkl audit without copying the 100 MB prebuilt file into sources.
    pkl_pin = config["pklBinaryPin"]
    pkl_hash = pkl_pin["hash"]
    if not pkl_hash.startswith("sha256-"):
        raise ValueError("Pkl binary pin is not a SHA-256 SRI hash")
    pkl_hex = base64.b64decode(pkl_hash.removeprefix("sha256-"), validate=True).hex()
    if len(pkl_hex) != 64:
        raise ValueError("Pkl binary SHA-256 has wrong length")
    add_file(root, "recipes/pkl-upstream-sha256.txt",
                              f"{pkl_hex}  {pkl_pin['url']}\n".encode())

    bun_archive = Path(next(item["path"] for item in config["bunSources"] if item["id"] == "bun"))
    libtcc_path = "src/runtime/ffi/libtcc1.c"
    libtcc_source = add_file(root, "sources/bun/libtcc1.c", extract_notice(bun_archive, libtcc_path))
    dtach_source = Path(next(item["path"] for item in config["native"] if item["id"] == "dtach"))
    gpl_notice = add_file(root, "licenses/bun/libtcc1/GPL-2.0.txt", (dtach_source / "COPYING").read_bytes())
    exception_notice = add_file(root, "licenses/bun/libtcc1/libtcc1.c", extract_notice(bun_archive, libtcc_path))
    components.append(component("bun-libtcc1", config["bunVersion"],
                                "GPL-2.0-or-later WITH libtcc1-linking-exception",
                                "Bun src/runtime/ffi/libtcc1.c", ["TCC-3"],
                                [gpl_notice, exception_notice], [libtcc_source]))

    mpl_text = extract_notice(Path(next(item["path"] for item in config["cargo"] if item["name"] == "cssparser")), "LICENSE")
    for name, version in (("cssparser", "0.36.0"), ("selectors", "0.33.0"), ("dtoa-short", "0.3.5")):
        crate = next(item for item in config["cargo"] if item["name"] == name and item["version"] == version)
        crate_path = f"sources/cargo/{name}-{version}.crate"
        notice = add_file(root, f"licenses/bun/mpl/{name}/MPL-2.0.txt", mpl_text)
        components.append(component(f"bun-{name}", version, "MPL-2.0",
                                    f"https://crates.io/crates/{name}/{version}", ["MPL-1"],
                                    [notice], [crate_path]))

    webkit = Path(config["webkitSource"])
    # Test data and website trees are not build inputs. The list only drops
    # bulk; a renamed or new tree is archived rather than failing the build.
    webkit_source = archive_tree(root, "sources/bun/webkit.tar.xz", webkit,
                                 exclude=("./LayoutTests", "./JSTests", "./PerformanceTests", "./Websites"))
    webkit_notice_files = [
        "Source/JavaScriptCore/COPYING.LIB",
        "Source/JavaScriptCore/disassembler/ARM64/LICENSE-binja.txt",
        "Source/JavaScriptCore/disassembler/zydis/LICENSE-zydis.txt",
        "Source/JavaScriptCore/disassembler/zydis/LICENSE-zycore.txt",
        "Source/JavaScriptCore/runtime/temporal/core/LICENSE-temporal_rs.txt",
        "Source/JavaScriptCore/runtime/temporal/core/LICENSE-icu4x.txt",
        "Source/WTF/LICENSE-libc++.txt",
        "Source/WTF/LICENSE-simde.txt",
        "Source/WTF/LICENSE-LLVM.txt",
        "Source/WTF/LICENSE-dragonbox.txt",
        "Source/WTF/icu/LICENSE",
        "Source/WTF/wtf/dtoa/COPYING",
        "Source/WTF/wtf/dtoa/LICENSE",
        "Source/WTF/wtf/simdutf/LICENSE-simdutf.txt",
        "Source/WTF/wtf/fast_float/LICENSE",
        "Source/bmalloc/mimalloc/mimalloc/LICENSE",
    ]
    webkit_notices = [add_file(root, f"licenses/bun/webkit/{name}", (webkit / name).read_bytes())
                      for name in webkit_notice_files]
    components.append(component("bun-webkit", config["webkitRevision"], policy["webkit"]["license"],
                                config["webkitOrigin"], policy["webkit"]["requirements"],
                                webkit_notices, [webkit_source]))

    for crate in config["cargo"]:
        archive = Path(crate["path"])
        slug = f"{crate['name']}-{crate['version']}"
        add_file(root, f"sources/cargo/{slug}.crate", archive)
        for name in top_level_notices(archive):
            add_file(root, f"licenses/bun/cargo-inputs/{slug}/{name}",
                     extract_notice(archive, name))
    # The fetched set covers both release architectures; each release keeps
    # only the archives `bun install` needs on its own CPU.
    npm_cpu = {"x86_64-linux": "x64", "aarch64-linux": "arm64"}[config["system"]]
    npm_index_path = "sources/bun/npm/packages.json"
    with tempfile.TemporaryDirectory(prefix="bun-npm-verify-") as temporary:
        subprocess.run(["tar", "-xf", str(bun_archive), "--strip-components=1", "-C", temporary],
                       check=True)
        (root / npm_index_path).parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["bun", config["npmVerifier"], "pins", temporary,
                        str(root / npm_index_path), npm_cpu], check=True)
        wanted = {pin["archive"] for pin in json.loads((root / npm_index_path).read_text())["packages"]}
        npm_seen = {}
        for package in config["npm"]:
            if package["archive"] not in wanted:
                continue
            archive = f"sources/bun/npm/{package['archive']}"
            if archive in npm_seen:
                if npm_seen[archive] != package["integrity"]:
                    raise ValueError(f"conflicting npm archive pins: {archive}")
                continue
            npm_seen[archive] = package["integrity"]
            add_file(root, archive, Path(package["path"]))
            actual = "sha512-" + base64.b64encode(hashlib.sha512((root / archive).read_bytes()).digest()).decode()
            if actual != package["integrity"]:
                raise ValueError(f"npm integrity mismatch: {package['name']}@{package['version']}")
            for name in top_level_notices(root / archive):
                add_file(root, f"licenses/bun/npm-inputs/{package['archive']}/{name}",
                         extract_notice(root / archive, name))
        if set(npm_seen) != {f"sources/bun/npm/{name}" for name in wanted}:
            raise ValueError("fetched npm archives do not cover the release architecture")
        subprocess.run(["bun", config["npmVerifier"], "verify", temporary,
                        str(root / npm_index_path), str(root / "sources/bun/npm"), npm_cpu],
                       check=True)
    recipe_paths = copy_recipes(root, config)
    components.extend(collect_javascript(root, config))

    own_notice = add_file(root, "licenses/nas/LICENSE", Path(config["nasSource"]) / "LICENSE")
    own_source = archive_tree(root, "sources/nas-source.tar.gz", Path(config["nasSource"]),
                              exclude=(".superpowers",))
    add_file(root, "sources/bun/nodejs-headers.tar.gz", Path(config["nodeHeaders"]))
    rust_toolchain = tomllib.loads(extract_notice(bun_archive, "rust-toolchain.toml").decode())
    if rust_toolchain["toolchain"]["channel"] != "nightly-2026-07-20":
        raise ValueError("Rust source pin differs from Bun's required toolchain")
    rust_archive = Path(config["rustSource"])
    rust_source = add_file(root, "sources/bun/rust-src-nightly-2026-07-20.tar.xz", rust_archive)
    with tarfile.open(rust_archive, "r:*") as archive:
        rust_notice_paths = sorted({
            "/".join(Path(member.name).parts[1:]) for member in archive
            if safe_member(member) and any(word in Path(member.name).name.lower()
                                          for word in ("license", "copyright", "copying", "notice"))
        })
    if not {"COPYRIGHT", "LICENSE-MIT", "LICENSE-APACHE"}.issubset(rust_notice_paths):
        raise ValueError("Rust source archive lacks its original license notices")
    rust_notices = [add_file(root, f"licenses/bun/rust-stdlib/{name}", body)
                    for name, body in extract_notices(rust_archive, rust_notice_paths).items()]
    rust_component = component("bun-rust-stdlib", "nightly-2026-07-20", "MIT AND file-specific terms",
                               "Bun pinned Rust nightly toolchain", ["BUN-7"], rust_notices, [rust_source])
    rust_component["decision"] = "Choose MIT for Rust's dual-licensed code and retain original third-party notices and LLVM exceptions; see BUN-7."
    components.append(rust_component)
    add_file(root, "licenses/README.txt", (
        "Bundled nas uses JavaScriptCore under the GNU Library General Public License v2 "
        "(bun/webkit/Source/JavaScriptCore/COPYING.LIB), TinyCC under LGPL 2.1 or later "
        "(bun/tinycc/COPYING), glibc under LGPL 2.1 or later and file-specific terms "
        "(native/glibc/COPYING.LIB and native/glibc/LICENSES), and libfuse under LGPL 2.1 "
        "(native/fuse3/LGPL2.txt). No nas distribution term restricts modification or "
        "reverse engineering of these libraries for debugging such modifications.\n"
        "Source materials for bundled nas, Bun/JavaScriptCore, TinyCC, glibc, libfuse, "
        "dtach, Pkl, and the pinned Rust standard library are under sources/. "
        "Bun's pinned Node headers are in sources/bun/nodejs-headers.tar.gz. "
        "This directory contains original license and copyright notices. See "
        "docs/release-materials.md in sources/nas-source.tar.gz for the rebuild route and "
        "the component inventory for each license decision and material path.\n"
    ).encode())
    # The Nix recipes rebuild the bundle, so they belong to nas itself.
    components.append(component("nas", config["nasVersion"], "repository license", "nas repository",
                                [], [own_notice], [own_source] + recipe_paths))
    for id_ in ("nas-hostexec", "nas-maskfs", "nas-mask-filter"):
        components.append(component(id_, config["nasVersion"], "repository license", "nas repository",
                                    [], [own_notice], [own_source]))
    # libgcc_s is resolvable for the bundle but not always copied into it.
    # Only a copied library is GPL object code needing GCC's source; code
    # compiled in under the runtime library exception carries no obligation.
    if "gcc-runtime" in shipped:
        gcc_source = add_file(root, "sources/native/gcc-runtime.tar.xz", Path(config["gccSource"]))
        gcc_notice = add_file(root, "licenses/native/gcc-runtime/COPYING.RUNTIME",
                              extract_notice(Path(config["gccSource"]), "COPYING.RUNTIME"))
        gcc_gpl = add_file(root, "licenses/native/gcc-runtime/COPYING3",
                           extract_notice(Path(config["gccSource"]), "COPYING3"))
        components.append(component("gcc-runtime", config["gccVersion"],
                                    "GPL-3.0-or-later WITH GCC-exception-3.1", "nixpkgs GCC runtime",
                                    [], [gcc_notice, gcc_gpl], [gcc_source]))

    bundler_recipe = next(path for path in recipe_paths if path.startswith("recipes/nix-bundle-elf."))
    bundler_notice = add_file(root, "licenses/native/nix-bundle-elf-runtime/LICENSE",
                              Path(config["bundlerLicense"]))
    components.append(component("nix-bundle-elf-runtime", config["bundlerRevision"], "MIT",
                                "pinned nix-bundle-elf", ["BUNDLE-1"],
                                [bundler_notice], [bundler_recipe]))
    manifest = {"schemaVersion": 1, "system": config["system"],
                "components": components, "payloadOrigins": origins}
    (root / "components.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
