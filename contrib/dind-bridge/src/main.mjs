// The dind-bridge entry point, bundled into one file for Node.js.
import { realpathSync } from "node:fs";
import {
  parseOptions,
  runCli,
} from "../../../src/docker/embed/dind-bridge-gateway.mjs";
import { loopbackEndpoint } from "../../../src/docker/embed/dind-bridge-protocol.mjs";
import { renderEnvFile } from "./env_file.mjs";
import { baseNetnsPath, prepareServe } from "./serve.mjs";

const VERSION =
  typeof DIND_BRIDGE_VERSION === "string" ? DIND_BRIDGE_VERSION : "dev";
const DEFAULTS = { "name-prefix": "dind-bridge", instance: "default" };

const USAGE = `usage: dind-bridge <command> [options]

  serve     --socket PATH --docker-host ENDPOINT [--publish-host HOST]
            [--publish-ip IP] [--api tcp://127.0.0.1:PORT]
  env-file  --socket PATH --api tcp://127.0.0.1:PORT [--instance NAME]
            [--name-prefix NAME] [--publish-ip IP] [--node PATH] [--script PATH]
  ensure    --socket PATH [--instance NAME] [--api ADDR] [--publish-ip IP]
  relay     (started by ensure)
  --version
`;

function envFileOptions(args) {
  const allowed = [
    "socket",
    "api",
    "instance",
    "name-prefix",
    "publish-ip",
    "node",
    "script",
  ];
  const opts = {};
  const rest = [...args];
  while (rest.length) {
    const key = rest.shift();
    if (!key?.startsWith("--") || !rest.length)
      throw new Error("invalid env-file arguments");
    const name = key.slice(2);
    if (!allowed.includes(name))
      throw new Error(`unknown option ${key} for env-file`);
    if (Object.hasOwn(opts, name)) throw new Error(`${key} given twice`);
    opts[name] = rest.shift();
  }
  for (const name of ["socket", "api"])
    if (!opts[name]) throw new Error(`--${name} is required`);
  // Validate --api the way the relay will, before writing it into a file.
  loopbackEndpoint(opts.api, "--api");
  return opts;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "--version") {
    process.stdout.write(`dind-bridge ${VERSION}\n`);
    return;
  }
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (command === "env-file") {
    const opts = envFileOptions(rest);
    process.stdout.write(
      renderEnvFile({
        version: VERSION,
        node: opts.node ?? process.execPath,
        script: opts.script ?? realpathSync(process.argv[1]),
        socket: opts.socket,
        api: opts.api,
        instance: opts.instance ?? DEFAULTS.instance,
        namePrefix: opts["name-prefix"] ?? DEFAULTS["name-prefix"],
        publishIp: opts["publish-ip"],
        baseNetnsFile: baseNetnsPath(opts.socket),
      }),
    );
    return;
  }
  if (command === "serve") {
    const opts = parseOptions("serve", rest);
    await prepareServe({ socket: opts.socket, api: opts.api });
  }
  await runCli(args, { script: process.argv[1], defaults: DEFAULTS });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`dind-bridge: ${error.message}`);
  process.exitCode = 1;
});
