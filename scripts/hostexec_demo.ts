import { mkdir } from "node:fs/promises";

const apiToken = process.env["HOSTEXEC_DEMO_API_TOKEN"];

if (!apiToken) {
  console.error("missing required hostexec demo env vars");
  process.exit(1);
}

const outputDir = `${process.cwd()}/.hostexec-demo`;
await mkdir(outputDir, { recursive: true });

console.log(`Running on host using .env secret`);
console.log(`stdout is redacted to avoid leaking secrets`);
console.log(`API_TOKEN: ${apiToken}`);
console.log(`First 3 characters of API_TOKEN: ${apiToken.slice(0, 3)}`);
