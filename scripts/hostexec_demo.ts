const apiBaseUrl = Deno.env.get("HOSTEXEC_DEMO_API_BASE_URL");
const apiToken = Deno.env.get("HOSTEXEC_DEMO_API_TOKEN");

if (!apiBaseUrl || !apiToken) {
  console.error("missing required hostexec demo env vars");
  Deno.exit(1);
}

const outputDir = `${Deno.cwd()}/.hostexec-demo`;
await Deno.mkdir(outputDir, { recursive: true });

const result = {
  cwd: Deno.cwd(),
  apiBaseUrl,
  apiToken,
  timestamp: new Date().toISOString(),
};

const outputPath = `${outputDir}/result.json`;
const resultJson = `${JSON.stringify(result, null, 2)}\n`;
await Deno.writeTextFile(outputPath, resultJson);
await Deno.stdout.write(new TextEncoder().encode(resultJson));
console.log(`hostexec demo wrote ${outputPath}`);
