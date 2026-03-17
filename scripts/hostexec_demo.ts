const apiToken = Deno.env.get("HOSTEXEC_DEMO_API_TOKEN");

if (!apiToken) {
  console.error("missing required hostexec demo env vars");
  Deno.exit(1);
}

const outputDir = `${Deno.cwd()}/.hostexec-demo`;
await Deno.mkdir(outputDir, { recursive: true });

console.log(`Running on host using .env secret`);
console.log(`stdout is redacted to avoid leaking secrets`);
console.log(`API_TOKEN: ${apiToken}`);
console.log(`First 3 characters of API_TOKEN: ${apiToken.slice(0, 3)}`);
