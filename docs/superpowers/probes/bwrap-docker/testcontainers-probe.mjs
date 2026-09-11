import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/probe-artifacts/sdk/package.json");
const { GenericContainer, Wait } = require("testcontainers");

assert.equal(process.getuid(), 1000);
assert.match(readFileSync("/proc/self/status", "utf8"), /^CapEff:\s+0+$/m);
assert.match(readFileSync("/proc/self/status", "utf8"), /^NoNewPrivs:\s+1$/m);
console.log("PASS SDK process has UID 1000, no effective capabilities, NoNewPrivs");

const container = await new GenericContainer("nas-bwrap-probe:local")
  .withName("nas-probe-sdk-http")
  .withExposedPorts(8080)
  .withWaitStrategy(Wait.forHttp("/", 8080).forStatusCode(200))
  .withStartupTimeout(15000)
  .start();
try {
  const response = await fetch(`http://${container.getHost()}:${container.getMappedPort(8080)}/`);
  assert.equal(await response.text(), "probe-ok\n");
  const result = await container.exec(["/fixture", "hello"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /fixture uid=0 gid=0/);
  console.log("PASS Testcontainers 12.1.0 start, HTTP wait, mapped port, exec");
} finally {
  await container.stop();
}

// Deliberately leave this resource for Ryuk. The outer shell owns the daemon
// and always terminates it, including when the Ryuk assertion fails.
await new GenericContainer("nas-bwrap-probe:local")
  .withName("nas-probe-ryuk-cleanup")
  .withExposedPorts(8080)
  .withWaitStrategy(Wait.forHttp("/", 8080).forStatusCode(200))
  .withStartupTimeout(15000)
  .start();
console.log("PASS Ryuk cleanup fixture created; closing SDK connection");
process.exit(0);
