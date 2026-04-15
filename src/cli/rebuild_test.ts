import { expect, test } from "bun:test";
import { createRebuildPrior } from "./rebuild.ts";

test("createRebuildPrior: seeds workspace slice for docker build stage", () => {
  const prior = createRebuildPrior("/repo/worktree", "nas-sandbox");

  expect(prior.workDir).toEqual("/repo/worktree");
  expect(prior.imageName).toEqual("nas-sandbox");
  expect(prior.workspace).toEqual({
    workDir: "/repo/worktree",
    imageName: "nas-sandbox",
  });
});
