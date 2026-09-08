import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { shellEscape } from "../dtach/client.ts";

// Tests outside the image may use Nix tools or fake commands. Relocate only a
// fixture copy; the shipped launcher has no runtime command-path override.
export async function createDirenvLauncherFixture(
  root: string,
  direnv: string,
  jq: string,
): Promise<string> {
  const source = await readFile(
    new URL("./embed/direnv-exec.sh", import.meta.url),
    "utf8",
  );
  const launcher = path.join(root, "direnv-exec.sh");
  await writeFile(
    launcher,
    source
      .replaceAll("/usr/bin/direnv", shellEscape([direnv]))
      .replaceAll("/usr/bin/jq", shellEscape([jq])),
    { mode: 0o755 },
  );
  return launcher;
}
