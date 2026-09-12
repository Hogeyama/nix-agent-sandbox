import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { shellEscape } from "../dtach/client.ts";

// Tests outside the image may use Nix tools or fake commands. Relocate only a
// fixture copy; the shipped launcher has no runtime command-path override.
export async function createDirenvLauncherFixture(
  root: string,
  direnv: string,
  jq: string,
): Promise<string> {
  const [source, bootstrapSource, librarySource, nixDirenvSource] =
    await Promise.all([
      readFile(new URL("./embed/direnv-exec.sh", import.meta.url), "utf8"),
      readFile(new URL("./embed/direnv-bootstrap.sh", import.meta.url), "utf8"),
      readFile(new URL("./embed/direnv-lib.sh", import.meta.url), "utf8"),
      readFile(new URL("./embed/nix-direnv.sh", import.meta.url), "utf8"),
    ]);
  const assets = path.join(root, "direnv assets");
  await mkdir(assets, { recursive: true });
  const bootstrap = path.join(assets, "direnv-bootstrap.sh");
  const library = path.join(assets, "direnv-lib.sh");
  const nixDirenv = path.join(assets, "nix-direnv.sh");
  await Promise.all([
    writeFile(bootstrap, bootstrapSource, { mode: 0o755 }),
    writeFile(
      library,
      librarySource.replaceAll("/usr/local/share/nas/nix-direnv.sh", nixDirenv),
    ),
    writeFile(nixDirenv, nixDirenvSource),
  ]);
  const launcher = path.join(root, "direnv-exec.sh");
  await writeFile(
    launcher,
    source
      .replaceAll("/usr/bin/direnv", shellEscape([direnv]))
      .replaceAll("/usr/bin/jq", shellEscape([jq]))
      .replaceAll(
        "/usr/local/libexec/nas-direnv-bootstrap",
        shellEscape([bootstrap]),
      )
      .replaceAll("/usr/local/share/nas/direnv-lib.sh", shellEscape([library])),
    { mode: 0o755 },
  );
  return launcher;
}
