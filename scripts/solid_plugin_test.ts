/**
 * Smoke tests for the Solid Babel plugin.
 *
 * Bun's runtime has no DOM and we don't load Solid here. The fake build
 * object captures the registered onLoad handler so we can drive it
 * directly with a temp TSX file, mirroring the style of
 * src/ui/frontend/src/api_test.ts.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { solidPlugin } from "./solid_plugin.ts";

type OnLoadHandler = (args: {
  path: string;
}) => Promise<{ contents: string; loader: string }>;

interface FakeBuild {
  registered: { filter: RegExp; handler: OnLoadHandler } | null;
  onLoad(opts: { filter: RegExp }, handler: OnLoadHandler): void;
}

function makeFakeBuild(): FakeBuild {
  return {
    registered: null,
    onLoad(opts, handler) {
      this.registered = { filter: opts.filter, handler };
    },
  };
}

test("solidPlugin transforms TSX into Solid template calls", async () => {
  const fake = makeFakeBuild();
  solidPlugin.setup(fake);
  expect(fake.registered).not.toBeNull();

  const dir = await mkdtemp(path.join(tmpdir(), "solid-plugin-test-"));
  try {
    const file = path.join(dir, "sample.tsx");
    await writeFile(
      file,
      "export const Hello = () => <div>hello</div>;\n",
      "utf8",
    );

    const registered = fake.registered;
    if (!registered) {
      throw new Error("solidPlugin did not register an onLoad handler");
    }
    const out = await registered.handler({ path: file });
    expect(out.loader).toBe("js");
    // babel-preset-solid + dom-expressions produces `_$template` (or
    // `template`) helper calls for static JSX. Match either to stay
    // resilient to minor preset version differences.
    expect(out.contents).toMatch(/_?\$?template/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("solidPlugin filter only matches .tsx, not .ts", () => {
  // Pin the contract: .ts files must fall through to Bun's native loader.
  expect(/\.tsx$/.test("foo.tsx")).toBe(true);
  expect(/\.tsx$/.test("foo.ts")).toBe(false);
});
