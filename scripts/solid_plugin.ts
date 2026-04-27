/**
 * Bun bundler plugin: TSX -> Solid template via Babel.
 *
 * Use as `Bun.build({ plugins: [solidPlugin] })`. We deliberately do not
 * call `Bun.plugin(...)` here so test runners are unaffected.
 */

import { readFile } from "node:fs/promises";
// @ts-expect-error -- @babel/core ships JS with no first-party types and we
// don't want @types/babel__core in deps. We only use transformAsync.
import { transformAsync } from "@babel/core";
// @ts-expect-error -- preset is a runtime value, no type package needed.
import babelTs from "@babel/preset-typescript";
// @ts-expect-error -- preset is a runtime value, no type package needed.
import babelSolid from "babel-preset-solid";

// biome-ignore lint/suspicious/noExplicitAny: Bun's plugin builder type is not exported in a stable shape.
type BunPluginBuilder = any;

export const solidPlugin = {
  name: "solid",
  setup(build: BunPluginBuilder) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }: { path: string }) => {
      const source = await readFile(path, "utf8");
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        sourceMaps: "inline",
        presets: [
          [
            babelTs,
            {
              onlyRemoveTypeImports: true,
              isTSX: true,
              allExtensions: true,
            },
          ],
          [babelSolid, { generate: "dom", hydratable: false }],
        ],
      });
      if (!result?.code) {
        throw new Error(`solid plugin: empty output for ${path}`);
      }
      return { contents: result.code, loader: "js" };
    });
  },
};

export default solidPlugin;
