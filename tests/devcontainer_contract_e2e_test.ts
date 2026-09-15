import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const FIXTURE_IMAGE =
  process.env.NAS_DEVCONTAINER_CONTRACT_IMAGE ??
  "nas-devcontainer-contract:latest";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  command: string[],
  options: { cwd?: string } = {},
): Promise<CommandResult> {
  const subprocess = Bun.spawn(command, {
    cwd: options.cwd,
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

async function commandSucceeds(command: string[]): Promise<boolean> {
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

async function isDevcontainerAvailable(): Promise<boolean> {
  return (
    Bun.which("devcontainer") !== null &&
    commandSucceeds(["devcontainer", "--version"])
  );
}

async function isFixtureImageAvailable(): Promise<boolean> {
  return (
    Bun.which("docker") !== null &&
    commandSucceeds(["docker", "image", "inspect", FIXTURE_IMAGE])
  );
}

const devcontainerAvailable = await isDevcontainerAvailable();
// A missing Dev Containers CLI already decides the skip. Avoid reaching the
// Docker daemon for prerequisites that cannot make this test runnable.
const dockerAvailable = devcontainerAvailable && (await isDockerAvailable());
const composeAvailable = dockerAvailable && (await isComposeAvailable());
const fixtureImageAvailable =
  composeAvailable && (await isFixtureImageAvailable());

const unavailableCapabilities = [
  !devcontainerAvailable && "Dev Containers CLI",
  devcontainerAvailable && !dockerAvailable && "Docker daemon",
  dockerAvailable && !composeAvailable && "Docker Compose v2",
  composeAvailable &&
    !fixtureImageAvailable &&
    `fixture image ${FIXTURE_IMAGE}`,
].filter((capability): capability is string => Boolean(capability));

function requireSuccess(result: CommandResult, operation: string): void {
  expect(
    result.exitCode,
    `${operation} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function parseDevcontainerResult(stdout: string): { containerId: string } {
  const candidates = [stdout, ...stdout.trim().split("\n").reverse()];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as { containerId?: unknown };
      if (typeof value.containerId === "string") {
        return { containerId: value.containerId };
      }
    } catch {
      // The CLI may emit progress lines before its final JSON result.
    }
  }
  throw new Error(`Dev Containers CLI returned no containerId:\n${stdout}`);
}

test.skipIf(
  !dockerAvailable ||
    !composeAvailable ||
    !devcontainerAvailable ||
    !fixtureImageAvailable,
)(
  `initializeCommand starts the Compose service before attach and reuses it${
    unavailableCapabilities.length > 0
      ? ` (missing: ${unavailableCapabilities.join(", ")})`
      : ""
  }`,
  async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "nas-devcontainer-contract-"),
    );
    const devcontainerDir = path.join(workspace, ".devcontainer");
    const composePath = path.join(devcontainerDir, "compose.json");
    const initializeScript = path.join(devcontainerDir, "initialize.sh");
    const markerPath = path.join(devcontainerDir, "initialized-container-id");
    const configPath = path.join(devcontainerDir, "devcontainer.json");
    const projectName = `nas-contract-${crypto.randomUUID()}`;
    let composeCleanupRequired = false;
    let testFailure: unknown;

    try {
      await mkdir(devcontainerDir, { recursive: true });
      await writeFile(
        composePath,
        JSON.stringify(
          {
            name: projectName,
            services: {
              agent: {
                image: FIXTURE_IMAGE,
                command: ["/bin/sh", "-c", "while :; do sleep 3600; done"],
                working_dir: workspace,
                volumes: [`${workspace}:${workspace}`],
              },
            },
          },
          null,
          2,
        ),
      );
      await writeFile(
        initializeScript,
        `#!/bin/sh
set -eu
compose_path=$1
project_name=$2
marker_path=$3
docker compose --project-name "$project_name" --file "$compose_path" up -d
docker compose --project-name "$project_name" --file "$compose_path" ps -q agent > "$marker_path"
`,
      );
      await chmod(initializeScript, 0o755);
      await writeFile(
        configPath,
        JSON.stringify(
          {
            name: "nas Dev Containers contract fixture",
            initializeCommand: [
              initializeScript,
              composePath,
              projectName,
              markerPath,
            ],
            dockerComposeFile: composePath,
            service: "agent",
            workspaceFolder: workspace,
            remoteUser: "nas-test",
            updateRemoteUserUID: false,
            overrideCommand: false,
            shutdownAction: "none",
            customizations: {
              vscode: {
                extensions: ["dbaeumer.vscode-eslint"],
                settings: { "remote.autoForwardPorts": false },
              },
            },
          },
          null,
          2,
        ),
      );

      const devcontainerArgs = [
        "--workspace-folder",
        workspace,
        "--config",
        configPath,
      ];

      composeCleanupRequired = true;
      const firstUp = await run(["devcontainer", "up", ...devcontainerArgs]);
      requireSuccess(firstUp, "first devcontainer up");
      const attachedContainerId = parseDevcontainerResult(
        firstUp.stdout,
      ).containerId;

      const markerContainerId = (await readFile(markerPath, "utf8")).trim();
      const initializedBeforeAttach = markerContainerId.length > 0;
      const inspect = await run([
        "docker",
        "compose",
        "--project-name",
        projectName,
        "--file",
        composePath,
        "ps",
        "-q",
        "agent",
      ]);
      requireSuccess(inspect, "docker compose ps");
      const createdContainerId = inspect.stdout.trim();

      const secondUp = await run(["devcontainer", "up", ...devcontainerArgs]);
      requireSuccess(secondUp, "second devcontainer up");
      const secondAttachContainerId = parseDevcontainerResult(
        secondUp.stdout,
      ).containerId;

      const identity = await run([
        "devcontainer",
        "exec",
        ...devcontainerArgs,
        "/bin/sh",
        "-lc",
        "id -u; printf '%s\\n' \"$HOME\"",
      ]);
      requireSuccess(identity, "devcontainer exec identity probe");
      const [uid, home] = identity.stdout.trim().split("\n");
      const remoteIdentity = { uid: Number(uid), home };

      expect(initializedBeforeAttach).toBe(true);
      expect(markerContainerId).toBe(createdContainerId);
      expect(attachedContainerId).toBe(createdContainerId);
      expect(secondAttachContainerId).toBe(createdContainerId);
      expect(remoteIdentity).toEqual({ uid: 1000, home: "/home/nas-test" });
    } catch (error) {
      testFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    if (composeCleanupRequired) {
      try {
        const down = await run([
          "docker",
          "compose",
          "--project-name",
          projectName,
          "--file",
          composePath,
          "down",
          "--volumes",
          "--remove-orphans",
        ]);
        if (down.exitCode !== 0) {
          throw new Error(
            `docker compose down failed\nstdout:\n${down.stdout}\nstderr:\n${down.stderr}`,
          );
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    if (cleanupFailures.length === 0) {
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    if (cleanupFailures.length > 0) {
      const failures =
        testFailure === undefined
          ? cleanupFailures
          : [testFailure, ...cleanupFailures];
      throw new AggregateError(
        failures,
        `Dev Containers contract cleanup failed; temporary workspace retained at ${workspace}`,
      );
    }
    if (testFailure !== undefined) {
      throw testFailure;
    }
  },
  120_000,
);
