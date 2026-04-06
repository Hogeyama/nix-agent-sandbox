/**
 * deno.json の "nix" フィールドからフラグを読み、deno compile を実行する。
 * tasks.compile と flake.nix の Single Source of Truth を deno.json に統一。
 */

const ROOT = new URL("../", import.meta.url).pathname;
const denoJson = JSON.parse(await Deno.readTextFile(`${ROOT}deno.json`));
const { entrypoint, permissions, includes } = denoJson["x-compile"];

const cmd = new Deno.Command("deno", {
  args: [
    "compile",
    ...permissions,
    ...includes.flatMap((p: string) => ["--include", p]),
    "--output",
    denoJson.name,
    entrypoint,
  ],
  cwd: ROOT,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const { code } = await cmd.output();
Deno.exit(code);
