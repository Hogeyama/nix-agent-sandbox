import { expect, test } from "bun:test";
import {
  type ForwardOwner,
  forwardKey,
  type ManagedForward,
  removeUserOwners,
} from "./port_forward_model.ts";

test("removing user owners retains only internal across every owner combination", () => {
  const possible: ForwardOwner[] = ["config", "dynamic", "internal"];
  for (let mask = 0; mask < 8; mask++) {
    const owners = possible.filter((_, index) => mask & (1 << index));
    const entry: ManagedForward = {
      direction: "remote",
      containerPort: 5432,
      hostPort: 5432,
      createdAt: "t",
      state: "active",
      owners,
    };
    expect(removeUserOwners(entry)).toEqual(
      owners.includes("internal") ? { ...entry, owners: ["internal"] } : null,
    );
    expect(entry.owners).toEqual(owners);
  }
});

test("direction keys preserve the opposite direction when deleting the same port", () => {
  const local = { direction: "local", containerPort: 5432 } as const;
  const remote = { direction: "remote", containerPort: 5432 } as const;
  const entries = new Map<string, typeof local | typeof remote>([
    [forwardKey(local), local],
    [forwardKey(remote), remote],
  ]);
  entries.delete(forwardKey(local));
  expect([...entries.values()]).toEqual([remote]);
});
