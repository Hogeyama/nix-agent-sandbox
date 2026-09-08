import { expect, test } from "bun:test";
import { normalizePortForwards } from "./port_forwards.ts";

test("legacy and remote config share one mapping and emit migration guidance", () => {
  const result = normalizePortForwards(
    "dev",
    {
      localForwards: [{ hostPort: 8080, containerPort: 3000 }],
      remoteForwards: [{ hostPort: 5432, containerPort: 5432 }],
      proxy: { forwardPorts: [5432] },
    },
    [18_080],
  );

  expect(result.errors).toEqual([]);
  expect(result.entries).toEqual([
    { direction: "local", hostPort: 8080, containerPort: 3000 },
    { direction: "remote", hostPort: 5432, containerPort: 5432 },
  ]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("dev");
  expect(result.warnings[0]).toContain("network.remoteForwards");
  expect(result.warnings[0]).toContain(
    "new PortForwardConfig { hostPort = 5432; containerPort = 5432 }",
  );
  expect(result.warnings[0]).toContain("docs/migration/port-forwarding.md");
});

test("normalization preserves order and absorbs exact duplicates", () => {
  const result = normalizePortForwards(
    "dev",
    {
      localForwards: [
        { hostPort: 8080, containerPort: 3000 },
        { hostPort: 8080, containerPort: 3000 },
      ],
      remoteForwards: [{ hostPort: 9000, containerPort: 4000 }],
      proxy: { forwardPorts: [5000] },
    },
    [],
  );
  expect(result.errors).toEqual([]);
  expect(result.entries).toEqual([
    { direction: "local", hostPort: 8080, containerPort: 3000 },
    { direction: "remote", hostPort: 9000, containerPort: 4000 },
    { direction: "remote", hostPort: 5000, containerPort: 5000 },
  ]);
});

test("normalization reports key, local listener, range, and reserved conflicts", () => {
  const result = normalizePortForwards(
    "broken",
    {
      localForwards: [
        { hostPort: 8080, containerPort: 3000 },
        { hostPort: 8080, containerPort: 4000 },
        { hostPort: 9000, containerPort: 3000 },
        { hostPort: 0, containerPort: 70_000 },
      ],
      remoteForwards: [{ hostPort: 1234, containerPort: 18_080 }],
    },
    [18_080],
  );
  expect(result.errors.join("\n")).toContain('profile "broken"');
  expect(result.errors.join("\n")).toContain(
    "network.localForwards[1].hostPort 8080",
  );
  expect(result.errors.join("\n")).toContain(
    "network.localForwards[2] conflicts with local:3000",
  );
  expect(result.errors.join("\n")).toContain(
    "network.localForwards[3].hostPort",
  );
  expect(result.errors.join("\n")).toContain(
    "network.localForwards[3].containerPort",
  );
  expect(result.errors.join("\n")).toContain(
    "network.remoteForwards[0].containerPort 18080",
  );
});

test("empty legacy default emits no warning", () => {
  expect(
    normalizePortForwards("dev", { proxy: { forwardPorts: [] } }, []).warnings,
  ).toEqual([]);
});
