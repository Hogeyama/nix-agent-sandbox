import { expect, test } from "bun:test";
import {
  cargoSources,
  labsJdkVersion,
  nativeSources,
  pklVersions,
} from "./fetch_sources.ts";

test("native sources follow additions in upstream definitions", () => {
  expect(
    nativeSources([
      {
        name: "added",
        source: () => ({
          kind: "github-archive",
          repo: "owner/added",
          commit: "abc",
        }),
      },
      { name: "sqlite", source: () => ({ kind: "in-tree" }) },
    ]),
  ).toEqual([{ id: "added", repo: "owner/added", revision: "abc" }]);
  expect(() =>
    nativeSources([{ name: "unknown", source: () => ({ kind: "prebuilt" }) }]),
  ).toThrow("Unsupported Bun dependency");
});

test("Cargo uses upstream checksums and rejects unsupported sources", () => {
  const entry = '[[package]]\nname="dep"\nversion="1.0.0"\n';
  expect(
    cargoSources(
      `${entry}source="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="${"00".repeat(32)}"`,
    ),
  ).toEqual([
    {
      name: "dep",
      version: "1.0.0",
      hash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  ]);
  expect(cargoSources(entry)).toEqual([]);
  expect(() =>
    cargoSources(`${entry}source="git+https://example.com/dep"`),
  ).toThrow("Unsupported Cargo source");
});

test("Pkl runtime versions follow its catalog and GraalVM source", () => {
  expect(
    pklVersions("version=0.31.1\n", '[versions]\ngraalVmJdkVersion="25.0.0"'),
  ).toEqual({ pkl: "0.31.1", graal: "25.0.0" });
  expect(
    labsJdkVersion(
      JSON.stringify({
        jdks: { "labsjdk-ce-latest": { version: "ce-25+37-jvmci-b01" } },
      }),
    ),
  ).toBe("25+37-jvmci-b01");
  expect(() => labsJdkVersion('{"jdks":{}}')).toThrow("Community LabsJDK pin");
  expect(() =>
    pklVersions("version=dev", '[versions]\ngraalVmJdkVersion="25.0.0"'),
  ).toThrow("release version");
});
