import { expect, test } from "bun:test";
import {
  resolveGatewayTestArtifacts,
  startGatewayTestHarness,
} from "./gateway_test_harness.ts";

const artifacts = await resolveGatewayTestArtifacts();
const bashAvailable = Bun.which("bash") !== null;
const catAvailable = Bun.which("cat") !== null;
const prerequisiteAvailability = {
  bash: bashAvailable,
  cat: catAvailable,
  client: artifacts.clientPath !== null,
  gateway: artifacts.gatewayPath !== null,
  interceptor: artifacts.interceptLibPath !== null,
} as const;
const missingPrerequisites = Object.entries(prerequisiteAvailability)
  .filter(([, available]) => !available)
  .map(([name]) => name);
const missingPrerequisiteReason =
  missingPrerequisites.length === 0
    ? "all prerequisites present; no diagnostic needed"
    : `missing ${missingPrerequisites.join(", ")}; install bash/coreutils as needed and run ` +
      "cd src/hostexec/intercept && zig build";
const bareGatewayAvailable =
  prerequisiteAvailability.bash &&
  prerequisiteAvailability.cat &&
  prerequisiteAvailability.client &&
  prerequisiteAvailability.gateway;
const interceptedGatewayAvailable =
  prerequisiteAvailability.bash &&
  prerequisiteAvailability.cat &&
  prerequisiteAvailability.gateway &&
  prerequisiteAvailability.interceptor;

test.skipIf(!bareGatewayAvailable)(
  "bare hostexec leaves unread stdin for the next command",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      const result = await harness.runBareShell(
        "printf payload | { intercepted-no-read; cat; }",
      );
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
      expect(harness.events.map(({ type }) => type)).toEqual([
        "spawned",
        "process_exit",
        "result",
      ]);
      expect(harness.events[1]).toMatchObject({
        type: "process_exit",
        exitCode: 0,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("payload");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!interceptedGatewayAvailable)(
  "LD_PRELOAD hostexec leaves unread stdin for the next command",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      const result = await harness.runInterceptedShell(
        `printf payload | { '${harness.interceptedNoReadPath}'; cat; }`,
      );
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].stdinMode).toBe("fd");
      expect(harness.events.map(({ type }) => type)).toEqual([
        "spawned",
        "process_exit",
        "result",
      ]);
      expect(harness.events[1]).toMatchObject({
        type: "process_exit",
        exitCode: 0,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("payload");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(missingPrerequisites.length === 0)(
  `hostexec FD gateway regressions skipped (${missingPrerequisiteReason})`,
  () => {
    expect(missingPrerequisites.length).toBeGreaterThan(0);
  },
);
