import { collectSiteErrors } from "../src/docs/site_check.ts";

const errors = await collectSiteErrors({
  siteDir: "docs-site/dist",
  basePath: "/nix-agent-sandbox",
  readme: { path: "README.md", minLines: 100, maxLines: 150 },
});

if (errors.length > 0) {
  for (const error of errors) console.error(`[docs] ${error}`);
  process.exit(1);
}

console.log("[docs] generated site validation passed");
