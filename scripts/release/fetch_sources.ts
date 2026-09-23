/** Fetch release source inputs inside a Nix fixed-output derivation. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pinsFromSource } from "./bun_npm.ts";

const run = (...args: string[]) =>
  execFileSync(args[0], args.slice(1), {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
interface Dependency {
  name: string;
  source: () => { kind: string; repo?: string; commit?: string };
}

export function nativeSources(deps: Dependency[]) {
  return deps.flatMap((dep) => {
    if (dep.name === "WebKit" || dep.name === "nodejs") return [];
    const source = dep.source();
    if (source.kind === "in-tree") return [];
    if (source.kind !== "github-archive" || !source.repo || !source.commit)
      throw new Error(
        `Unsupported Bun dependency: ${dep.name} (${source.kind})`,
      );
    return [{ id: dep.name, repo: source.repo, revision: source.commit }];
  });
}

export function cargoSources(lockText: string) {
  const lock = Bun.TOML.parse(lockText) as {
    package: {
      name: string;
      version: string;
      source?: string;
      checksum?: string;
    }[];
  };
  return lock.package.flatMap((pkg) => {
    if (!pkg.source) return [];
    if (
      pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
      !pkg.checksum ||
      !/^[a-f0-9]{64}$/.test(pkg.checksum)
    )
      throw new Error(`Unsupported Cargo source/checksum: ${pkg.name}`);
    return [
      {
        name: pkg.name,
        version: pkg.version,
        hash: `sha256-${Buffer.from(pkg.checksum, "hex").toString("base64")}`,
      },
    ];
  });
}

export function pklVersions(properties: string, catalog: string) {
  const pkl = properties.match(/^version=(\d+\.\d+\.\d+)$/m)?.[1];
  const { versions } = Bun.TOML.parse(catalog) as {
    versions: Record<string, string>;
  };
  const graal = versions.graalVmJdkVersion;
  if (!pkl || !/^\d+\.\d+\.\d+$/.test(graal ?? ""))
    throw new Error(
      "Pkl source lacks a release version or GraalVM JDK version",
    );
  return { pkl, graal };
}

export function labsJdkVersion(common: string): string {
  const version = JSON.parse(common).jdks?.["labsjdk-ce-latest"]?.version;
  if (typeof version !== "string" || !/^ce-\d[^/\s]+$/.test(version))
    throw new Error("GraalVM source lacks its Community LabsJDK pin");
  return version.slice(3);
}

async function parallel<T, R>(
  items: T[],
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await action(items[index]);
      }
    }),
  );
  return result;
}

export async function fetchSources(
  bunSource: string,
  pklSource: string,
  out: string,
) {
  async function archive(url: string, relative: string, integrity?: string) {
    const target = join(out, relative);
    await mkdir(dirname(target), { recursive: true });
    const proc = Bun.spawn(
      [
        "curl",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        url,
        "--output",
        target,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0)
      throw new Error(`Source download failed: ${url}`);
    const bytes = await readFile(target);
    if (integrity) {
      const [algorithm, digest] = integrity.split("-");
      if (createHash(algorithm).update(bytes).digest("base64") !== digest)
        throw new Error(`Source integrity mismatch: ${url}`);
    }
    return {
      path: relative,
      hash: `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
    };
  }
  const npmPins = await pinsFromSource(bunSource);
  const { allDeps } = await import(
    pathToFileURL(join(bunSource, "scripts/build/deps/index.ts")).href
  );
  const bunSources = [
    {
      id: "bun",
      repo: "oven-sh/bun",
      revision: `bun-v${npmPins.bunVersion}`,
      origin: `https://github.com/oven-sh/bun/tree/bun-v${npmPins.bunVersion}`,
      path: "bun.tar.gz",
    },
    ...(await parallel(nativeSources(allDeps), async (item) => ({
      ...item,
      origin: `https://github.com/${item.repo}/tree/${item.revision}`,
      ...(await archive(
        `https://github.com/${item.repo}/archive/${item.revision}.tar.gz`,
        `native/${item.id}.tar.gz`,
      )),
    }))),
  ];
  const cargo = await parallel(
    cargoSources(await readFile(join(bunSource, "Cargo.lock"), "utf8")),
    async (item) => ({
      ...item,
      ...(await archive(
        `https://static.crates.io/crates/${item.name}/${item.name}-${item.version}.crate`,
        `cargo/${item.name}-${item.version}.crate`,
        item.hash,
      )),
    }),
  );
  await parallel(
    [...new Map(npmPins.packages.map((item) => [item.archive, item])).values()],
    async (item) => archive(item.url, `npm/${item.archive}`, item.integrity),
  );
  const npm = npmPins.packages.map((item) => ({
    ...item,
    path: `npm/${item.archive}`,
  }));

  const { pkl, graal } = pklVersions(
    await readFile(join(pklSource, "gradle.properties"), "utf8"),
    await readFile(join(pklSource, "gradle/libs.versions.toml"), "utf8"),
  );
  async function runtime(
    id: string,
    repo: string,
    tag: string,
    version: string,
  ) {
    const refs = new Map(
      run(
        "git",
        "ls-remote",
        `https://github.com/${repo}.git`,
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      )
        .trim()
        .split("\n")
        .map((line) => {
          const [sha, ref] = line.split(/\s+/);
          return [ref, sha];
        }),
    );
    const revision =
      refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
    if (!revision || !/^[a-f0-9]{40}$/.test(revision))
      throw new Error(`Missing upstream tag: ${repo} ${tag}`);
    const url = `https://codeload.github.com/${repo}/tar.gz/${revision}`;
    return {
      id,
      version,
      url,
      origin: `https://github.com/${repo}/tree/${revision} (${tag})`,
      ...(await archive(url, `pkl/${id}.tar.gz`)),
    };
  }
  const graalPin = await runtime(
    "pkl-graalvm-runtime",
    "oracle/graal",
    `jdk-${graal}`,
    graal,
  );
  const graalArchive = join(out, graalPin.path);
  const root = run("tar", "-tzf", graalArchive).split("/")[0];
  const jdk = labsJdkVersion(
    run("tar", "-xOf", graalArchive, `${root}/common.json`),
  );
  const jdkPin = await runtime(
    "pkl-openjdk-runtime",
    "graalvm/labs-openjdk",
    jdk,
    jdk,
  );
  await writeFile(
    join(out, "bun-npm-sources.json"),
    `${JSON.stringify(npmPins, null, 2)}\n`,
  );
  await writeFile(
    join(out, "sources.json"),
    `${JSON.stringify(
      {
        bunVersion: npmPins.bunVersion,
        pklVersion: pkl,
        bunSources,
        cargo,
        npm,
        pklSources: [graalPin, jdkPin],
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  const [bun, pkl, out, ...extra] = Bun.argv.slice(2);
  if (!bun || !pkl || !out || extra.length)
    throw new Error("Usage: fetch_sources.ts BUN_SOURCE PKL_SOURCE OUT");
  await fetchSources(resolve(bun), resolve(pkl), resolve(out));
}
