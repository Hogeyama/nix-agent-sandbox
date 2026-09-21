import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Keep daemon connection settings, but never inherit registry credentials/helpers. */
export function isolateDockerConfig(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const configPath = join(source, "config.json");
  const original = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  const config: Record<string, unknown> = {};
  for (const key of ["currentContext", "cliPluginsExtraDirs"]) {
    if (original[key] !== undefined) config[key] = original[key];
  }
  writeFileSync(join(target, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  // Context metadata and TLS material select/authenticate the same daemon.
  // Registry auths, credsStore, credHelpers, and container proxy settings stay out.
  for (const entry of ["contexts", "ca.pem", "cert.pem", "key.pem"]) {
    if (existsSync(join(source, entry))) {
      cpSync(join(source, entry), join(target, entry), { recursive: true });
    }
  }
}
