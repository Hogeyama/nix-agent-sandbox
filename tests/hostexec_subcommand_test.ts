import { assertEquals } from "@std/assert";
import { normalizeSubcommand } from "../src/hostexec/subcommand.ts";

Deno.test("normalizeSubcommand: configured prefix option value is skipped", () => {
  const subcommand = normalizeSubcommand(
    "git",
    ["-C", "/repo", "pull"],
    {
      prefixOptionsWithValue: {
        git: ["-C"],
      },
    },
  );

  assertEquals(subcommand, "pull");
});

Deno.test("normalizeSubcommand: configured long option with inline value is skipped", () => {
  const subcommand = normalizeSubcommand(
    "gh",
    ["--repo=owner/repo", "pr", "list"],
    {
      prefixOptionsWithValue: {
        gh: ["--repo"],
      },
    },
  );

  assertEquals(subcommand, "pr");
});

Deno.test("normalizeSubcommand: without configuration option-looking argument becomes subcommand", () => {
  const subcommand = normalizeSubcommand(
    "git",
    ["-C", "/repo", "pull"],
    {
      prefixOptionsWithValue: {},
    },
  );

  assertEquals(subcommand, "/repo");
});
