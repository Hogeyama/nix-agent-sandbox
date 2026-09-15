import { expect, test } from "bun:test";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import { compileCompose, serializeCompose } from "./compose.ts";

function makePlan(overrides: Partial<ContainerPlan> = {}): ContainerPlan {
  return {
    ...emptyContainerPlan("nas-sandbox", "/work/project"),
    network: { mode: "network", name: "nas-session-example", alias: "agent" },
    ...overrides,
  };
}

test("compileCompose: preserves launch fields in Compose-native structure", () => {
  const plan = makePlan({
    image: "nas-sandbox:$tag",
    workDir: "/work/project with spaces",
    mounts: [
      { source: "/work/project with spaces", target: "/work/project" },
      { source: "/host/$config", target: "/etc/nas/config", readOnly: true },
    ],
    env: {
      static: {
        EMPTY: "",
        KEY_$NAME: "key remains literal",
        VALUE: `literal $HOME\n\${MISSING}`,
      },
      dynamicOps: [
        { mode: "prefix", key: "PATH", value: "/opt/$tools", separator: ":" },
      ],
    },
    extraHosts: [{ host: "gateway.internal", ip: "192.0.2.10" }],
    shmSize: "2g",
    command: {
      agentCommand: ["claude", "serve"],
      extraArgs: ["", "argument with spaces", "$HOME"],
    },
    labels: {
      "nas.managed": "true",
      "literal.$key": `value-\${SESSION}`,
    },
  });

  const document = compileCompose(
    plan,
    "nas-agent-sess_$example",
    "nas-devcontainer-example",
  );

  expect(document).toEqual({
    name: "nas-devcontainer-example",
    services: {
      agent: {
        image: "nas-sandbox:$$tag",
        container_name: "nas-agent-sess_$$example",
        working_dir: "/work/project with spaces",
        command: ["/usr/local/bin/nas-devcontainer-idle"],
        restart: "no",
        logging: { driver: "none" },
        volumes: [
          {
            type: "bind",
            source: "/work/project with spaces",
            target: "/work/project",
            read_only: false,
            bind: { create_host_path: false },
          },
          {
            type: "bind",
            source: "/host/$$config",
            target: "/etc/nas/config",
            read_only: true,
            bind: { create_host_path: false },
          },
        ],
        networks: { session: { aliases: ["agent"] } },
        environment: {
          EMPTY: "",
          KEY_$NAME: "key remains literal",
          VALUE: `literal $$HOME\n$\${MISSING}`,
          NAS_ENV_OPS: "__nas_pfx 'PATH' '/opt/$$tools' ':'",
        },
        extra_hosts: ["gateway.internal:192.0.2.10"],
        shm_size: "2g",
        labels: {
          "nas.managed": "true",
          "literal.$key": `value-$\${SESSION}`,
        },
      },
    },
    networks: {
      session: { external: true, name: "nas-session-example" },
    },
  });
});

test("serializeCompose: escapes dollar signs exactly once during compilation", () => {
  const plan = makePlan({
    env: { static: { VALUE: `$HOME\n\${MISSING}` }, dynamicOps: [] },
  });
  const document = compileCompose(plan, "nas-agent-test", "nas-test");

  const first = serializeCompose(document);
  const second = serializeCompose(document);

  expect(first).toBe(second);
  expect(first.endsWith("\n")).toBe(true);
  expect(JSON.parse(first).services.agent.environment.VALUE).toBe(
    `$$HOME\n$\${MISSING}`,
  );
  expect(JSON.parse(first).services.agent.environment).toHaveProperty("VALUE");
});

test("compileCompose: omits an alias when the network has none", () => {
  const document = compileCompose(
    makePlan({ network: { mode: "network", name: "nas-session" } }),
    "nas-agent-test",
    "nas-test",
  );

  expect(document.services.agent.networks).toEqual({ session: {} });
});

test("compileCompose: rejects plans without a named network", () => {
  expect(() =>
    compileCompose(
      { ...makePlan(), network: undefined },
      "nas-agent-test",
      "nas-test",
    ),
  ).toThrow("named network");
});

test("compileCompose: rejects container network mode", () => {
  expect(() =>
    compileCompose(
      makePlan({
        network: { mode: "container", containerName: "nas-dind-sidecar" },
      }),
      "nas-agent-test",
      "nas-test",
    ),
  ).toThrow("container network mode");
});

test("compileCompose: rejects remaining Docker run arguments", () => {
  expect(() =>
    compileCompose(
      makePlan({ extraRunArgs: ["--privileged"] }),
      "nas-agent-test",
      "nas-test",
    ),
  ).toThrow("extraRunArgs");
});
