import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// src/core is what has to be reviewed for security: it alone decides what
// leaves the sandbox and what runs on the host. It must not depend on
// src/ui, so that changing the UI never widens what needs that review.
test("src/core imports nothing from src/ui", () => {
  const dir = join(import.meta.dir, "core");
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith("_test.ts")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(
      /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
    )) {
      const spec = m[1] as string;
      if (spec.startsWith(".") && !spec.startsWith("./"))
        offenders.push(`${f}: ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

// strait makes STRAIT_ROOT read-only in the sandbox, because everything under
// it runs on the host at the next launch. Moving main.ts must not shrink it.
test("STRAIT_ROOT is the whole strait directory", async () => {
  const { STRAIT_ROOT } = await import("./core/main.ts");
  expect(STRAIT_ROOT).toBe(join(import.meta.dir, ".."));
  for (const f of ["strait", "package.json", "VERSION", "patches", "src"]) {
    expect(readdirSync(STRAIT_ROOT)).toContain(f);
  }
});
