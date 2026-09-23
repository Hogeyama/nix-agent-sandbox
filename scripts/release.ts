import { prepareRelease } from "./release/prepare.ts";
import { verifyRelease } from "./release/verify.ts";

function flags(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !flag?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      parsed[flag]
    ) {
      throw new Error(`invalid argument near ${flag ?? "end"}`);
    }
    parsed[flag] = value;
  }
  return parsed;
}

function required(
  args: Record<string, string>,
  names: string[],
): Record<string, string> {
  for (const name of names) if (!args[name]) throw new Error(`missing ${name}`);
  for (const name of Object.keys(args))
    if (!names.includes(name)) throw new Error(`unexpected ${name}`);
  return args;
}

try {
  const [operation, ...rest] = Bun.argv.slice(2);
  const args = flags(rest);
  if (operation === "prepare") {
    required(args, ["--inputs", "--binary", "--out", "--tag"]);
    const inventory = await prepareRelease({
      inputs: args["--inputs"],
      binary: args["--binary"],
      out: args["--out"],
      tag: args["--tag"],
    });
    console.log(
      `staged ${inventory.system}: ${inventory.binaryArchive}, ${inventory.materialsArchive}, ${inventory.componentsArtifact}`,
    );
  } else if (operation === "verify") {
    required(args, ["--stage"]);
    await verifyRelease({ stage: args["--stage"] });
    console.log("release artifacts verified");
  } else
    throw new Error(
      "usage: release.ts prepare --inputs DIR --binary FILE --out DIR --tag TAG | verify --stage DIR",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
