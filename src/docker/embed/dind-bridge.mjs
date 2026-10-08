// The nas entry point. Everything else lives in modules that never start
// themselves, so another entry can import them, bundled or not.
import { runCli } from "./dind-bridge-gateway.mjs";

runCli(process.argv.slice(2), { script: process.argv[1] }).catch((error) => {
  console.error(`nas DinD bridge: ${error.message}`);
  process.exitCode = 1;
});
