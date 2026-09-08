import { expect, test } from "bun:test";
import { buildInitialForwards } from "./initial_forwards.ts";

test("the receiver retains internal ownership when also configured", () => {
  expect(
    buildInitialForwards(
      [{ direction: "remote", hostPort: 4318, containerPort: 4318 }],
      4318,
    ),
  ).toEqual([
    {
      direction: "remote",
      hostPort: 4318,
      containerPort: 4318,
      owners: ["config", "internal"],
    },
  ]);
});

test("different mappings on one key cannot replace the receiver", () => {
  expect(() =>
    buildInitialForwards(
      [{ direction: "remote", hostPort: 9999, containerPort: 4318 }],
      4318,
    ),
  ).toThrow("conflicting");
});

test("initial entries retain direction and port pairs without duplicates", () => {
  expect(
    buildInitialForwards(
      [
        { direction: "local", hostPort: 9000, containerPort: 3000 },
        { direction: "local", hostPort: 9000, containerPort: 3000 },
        { direction: "remote", hostPort: 5432, containerPort: 15432 },
      ],
      null,
    ),
  ).toEqual([
    {
      direction: "local",
      hostPort: 9000,
      containerPort: 3000,
      owners: ["config"],
    },
    {
      direction: "remote",
      hostPort: 5432,
      containerPort: 15432,
      owners: ["config"],
    },
  ]);
});
