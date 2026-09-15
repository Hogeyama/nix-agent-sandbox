import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { emptyContainerPlan } from "../pipeline/container_plan.ts";
import type { ContainerPlan } from "../pipeline/state.ts";
import { DockerService, DockerServiceLive } from "../services/docker.ts";
import { compileCompose, serializeCompose } from "../stages/launch/compose.ts";
import { compareLaunchInspection } from "../stages/launch/inspection.ts";

const FIXTURE_IMAGE =
  process.env.NAS_DEVCONTAINER_CONTRACT_IMAGE ??
  "nas-devcontainer-contract:latest";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: readonly string[]): Promise<CommandResult> {
  const subprocess = Bun.spawn([...command], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function commandSucceeds(command: readonly string[]): Promise<boolean> {
  try {
    return (await run(command)).exitCode === 0;
  } catch {
    return false;
  }
}

async function isDockerAvailable(): Promise<boolean> {
  return Bun.which("docker") !== null && commandSucceeds(["docker", "info"]);
}

async function isComposeAvailable(): Promise<boolean> {
  return (
    Bun.which("docker") !== null &&
    commandSucceeds(["docker", "compose", "version"])
  );
}

async function isFixtureImageAvailable(): Promise<boolean> {
  return (
    Bun.which("docker") !== null &&
    commandSucceeds(["docker", "image", "inspect", FIXTURE_IMAGE])
  );
}

const dockerAvailable = await isDockerAvailable();
const composeAvailable: boolean | null = dockerAvailable
  ? await isComposeAvailable()
  : null;
const fixtureImageAvailable: boolean | null =
  composeAvailable === true ? await isFixtureImageAvailable() : null;

const unavailableCapabilities = [
  !dockerAvailable && "Docker daemon",
  composeAvailable === false && "Docker Compose plugin",
  fixtureImageAvailable === false && `fixture image ${FIXTURE_IMAGE}`,
].filter((capability): capability is string => Boolean(capability));
const unprobedCapabilities = [
  composeAvailable === null && "Docker Compose plugin",
  fixtureImageAvailable === null && `fixture image ${FIXTURE_IMAGE}`,
].filter((capability): capability is string => Boolean(capability));

function requireSuccess(result: CommandResult, operation: string): void {
  expect(
    result.exitCode,
    `${operation} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

test.skipIf(
  !dockerAvailable ||
    composeAvailable !== true ||
    fixtureImageAvailable !== true,
)(
  `Compose preserves literal values and the Live inspection matches the plan${
    unavailableCapabilities.length > 0 || unprobedCapabilities.length > 0
      ? ` (${[
          unavailableCapabilities.length > 0 &&
            `missing: ${unavailableCapabilities.join(", ")}`,
          unprobedCapabilities.length > 0 &&
            `not probed: ${unprobedCapabilities.join(", ")}`,
        ]
          .filter(Boolean)
          .join("; ")})`
      : ""
  }`,
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nas-launch-inspection-$-"));
    const workspace = path.join(root, "workspace-$literal");
    const idleScript = path.join(root, "idle-$fixture.sh");
    const composePath = path.join(root, "compose.json");
    const unique = crypto.randomUUID().replaceAll("-", "");
    const projectName = `nasinspect${unique}`;
    const containerName = `nas-inspect-${unique}`;
    const networkName = `nas-inspect-net-${unique}`;
    const literalValue = `left$middle-\${right}`;
    const cleanupErrors: Error[] = [];
    let testError: unknown;

    const plan: ContainerPlan = {
      ...emptyContainerPlan(FIXTURE_IMAGE, workspace),
      mounts: [
        { source: workspace, target: workspace },
        {
          source: idleScript,
          target: "/usr/local/bin/nas-devcontainer-idle",
          readOnly: true,
        },
      ],
      env: { static: { NAS_LITERAL_VALUE: literalValue }, dynamicOps: [] },
      command: {
        agentCommand: ["claude"],
        extraArgs: ["", "two words", "$literal"],
      },
      network: { mode: "network", name: networkName, alias: "agent" },
      labels: { "nas.managed": "true", "nas.session-id": unique },
    };
    const compose = compileCompose(plan, containerName, projectName);

    try {
      await mkdir(workspace);
      await writeFile(
        idleScript,
        "#!/bin/sh\nset -eu\nwhile :; do sleep 3600; done\n",
      );
      await chmod(idleScript, 0o755);
      await writeFile(composePath, serializeCompose(compose), { mode: 0o600 });

      requireSuccess(
        await run(["docker", "network", "create", networkName]),
        "docker network create",
      );

      const configResult = await run([
        "docker",
        "compose",
        "--project-name",
        projectName,
        "--file",
        composePath,
        "config",
        "--format",
        "json",
      ]);
      requireSuccess(configResult, "docker compose config");
      const configured = JSON.parse(configResult.stdout) as {
        services: {
          agent: {
            environment: Record<string, string>;
            volumes: Array<{
              source: string;
              target: string;
              read_only: boolean;
            }>;
          };
        };
      };
      expect(configured.services.agent.environment.NAS_LITERAL_VALUE).toBe(
        compose.services.agent.environment.NAS_LITERAL_VALUE,
      );
      expect(configured.services.agent.volumes).toContainEqual(
        expect.objectContaining({
          source: compose.services.agent.volumes[1].source,
          target: "/usr/local/bin/nas-devcontainer-idle",
          read_only: true,
        }),
      );

      const image = await Effect.runPromise(
        Effect.flatMap(DockerService, (docker) =>
          docker.inspectLaunchImage(FIXTURE_IMAGE),
        ).pipe(Effect.provide(DockerServiceLive)),
      );

      requireSuccess(
        await run([
          "docker",
          "compose",
          "--project-name",
          projectName,
          "--file",
          composePath,
          "up",
          "--detach",
        ]),
        "docker compose up",
      );
      const psResult = await run([
        "docker",
        "compose",
        "--project-name",
        projectName,
        "--file",
        composePath,
        "ps",
        "--quiet",
        "agent",
      ]);
      requireSuccess(psResult, "docker compose ps");
      const containerId = psResult.stdout.trim();
      expect(containerId.length).toBeGreaterThan(0);

      const actual = await Effect.runPromise(
        Effect.flatMap(DockerService, (docker) =>
          docker.inspectLaunch(containerId),
        ).pipe(Effect.provide(DockerServiceLive)),
      );
      expect(actual.config.command).toEqual([
        "/usr/local/bin/nas-devcontainer-idle",
        "",
        "two words",
        "$literal",
      ]);
      expect(
        compareLaunchInspection(
          {
            containerId,
            container: plan,
            image,
            // Inspection compares Docker argv after Compose interpolation.
            command: [
              "/usr/local/bin/nas-devcontainer-idle",
              ...plan.command.extraArgs,
            ],
          },
          actual,
        ),
      ).toEqual([]);
    } catch (error) {
      testError = error;
    } finally {
      const down = await run([
        "docker",
        "compose",
        "--project-name",
        projectName,
        "--file",
        composePath,
        "down",
        "--remove-orphans",
      ]).catch((error) => ({
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
      if (down.exitCode !== 0) {
        cleanupErrors.push(
          new Error(`docker compose down failed: ${down.stderr}`),
        );
      }
      const networkRm = await run([
        "docker",
        "network",
        "rm",
        networkName,
      ]).catch((error) => ({
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
      if (networkRm.exitCode !== 0) {
        cleanupErrors.push(
          new Error(`docker network rm failed: ${networkRm.stderr}`),
        );
      }
      await rm(root, { recursive: true, force: true }).catch((error) => {
        cleanupErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
        "launch inspection test or cleanup failed",
      );
    }
    if (testError !== undefined) throw testError;
  },
  30_000,
);
