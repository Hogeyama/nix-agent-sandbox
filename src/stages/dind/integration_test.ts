import { expect, test } from "bun:test";

/**
 * DindStage integration テスト（実 Docker 使用, DinD rootless 必須）
 *
 * DinD rootless は --privileged と user namespace サポートが必要なため、
 * 対応していない環境では自動スキップする。
 */

import { Effect, Exit, Scope } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import {
  dockerIsRunning,
  dockerNetworkCreateInternal,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
  dockerVolumeRemove,
} from "../../docker/client.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type {
  HostEnv,
  ProbeResults,
  StageInput,
} from "../../pipeline/types.ts";
import { DindServiceLive } from "../../stages/dind.ts";
import { createDindStageWithOptions, planDind } from "../dind.ts";

type NetworkOverrides = Partial<Omit<Profile["network"], "prompt">> & {
  prompt?: Partial<Profile["network"]["prompt"]>;
};

type ProfileOverrides = Omit<Partial<Profile>, "network"> & {
  network?: NetworkOverrides;
};

function makeProfile(overrides: ProfileOverrides = {}): Profile {
  const baseNetwork = structuredClone(DEFAULT_NETWORK_CONFIG);
  const { network, ...rest } = overrides;
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: {
      ...baseNetwork,
      ...network,
      prompt: {
        ...baseNetwork.prompt,
        ...network?.prompt,
      },
    },
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
  };
}

function makeSharedInput(
  profile: Profile,
  sessionId = "test-session-1234",
): StageInput {
  const config = makeConfig(profile);
  const hostEnv: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const probes: ProbeResults = {
    hasHostNix: false,
    xdgDbusProxyPath: null,
    dbusSessionAddress: null,
    gpgAgentSocket: null,
    auditDir: "/tmp/audit",
  };
  return {
    config,
    profile,
    profileName: "default",
    sessionId,
    host: hostEnv,
    probes,
  };
}

type DindSliceState = Pick<
  PipelineState,
  "workspace" | "container" | "network" | "proxy"
>;

function makeStageState(
  overrides: Partial<DindSliceState> = {},
): DindSliceState {
  const workspace = overrides.workspace ?? {
    workDir: "/tmp",
    imageName: "nas:latest",
  };
  const container = overrides.container ?? {
    ...emptyContainerPlan(workspace.imageName, workspace.workDir),
    command: { agentCommand: ["claude"], extraArgs: [] },
  };
  const network = overrides.network ?? {
    networkName: "nas-session-net-test-session-1234",
    runtimeDir: "/run/user/1000/nas/network",
  };
  const proxy = overrides.proxy ?? {
    brokerSocket: "/run/user/1000/nas/network/brokers/test-session-1234/sock",
    proxyEndpoint: "http://test-session-1234:tok@nas-envoy:15001",
  };
  return { workspace, container, network, proxy };
}

/**
 * DinD rootless が動作可能か事前チェック。
 * コンテナを起動して数秒待ち、まだ running なら OK。
 */
async function canRunDindRootless(): Promise<boolean> {
  const name = "nas-test-dind-probe";
  try {
    const exitCode = await Bun.spawn(
      [
        "docker",
        "run",
        "-d",
        "--rm",
        "--privileged",
        "--name",
        name,
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "docker:dind-rootless",
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    if (exitCode !== 0) return false;

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const running = await dockerIsRunning(name);
      if (running) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  } catch {
    return false;
  } finally {
    await dockerStop(name, { timeoutSeconds: 0 }).catch(() => {});
    await dockerRm(name).catch(() => {});
  }
}

const RUNNING_ON_HOST_DOCKER = !process.env.DOCKER_HOST;
const dindAvailable = await canRunDindRootless();

/** Inner test image. Must be pullable on the host so we can side-load it into
 * the (network-confined) sidecar via `docker save | docker load` instead of
 * relying on an inner pull (which would have to traverse the severed network).
 */
const INNER_IMAGE = "alpine:3.19";

/** Pull an image into the host (outer) docker. Returns true on success. */
async function hostPull(image: string): Promise<boolean> {
  const code = await Bun.spawn(["docker", "pull", image], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  return code === 0;
}

/**
 * Side-load a host image into the sidecar's inner dockerd without using the
 * sidecar's (severed) network: pipe `docker save <image>` on the host into
 * `docker exec -i <sidecar> docker -H tcp://127.0.0.1:2375 load`. Both ends ride
 * the outer docker daemon / the exec stream, so no inner egress is required.
 */
async function loadImageIntoSidecar(
  sidecar: string,
  image: string,
): Promise<boolean> {
  const save = Bun.spawn(["docker", "save", image], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const load = Bun.spawn(
    [
      "docker",
      "exec",
      "-i",
      sidecar,
      "docker",
      "-H",
      "tcp://127.0.0.1:2375",
      "load",
    ],
    { stdin: save.stdout, stdout: "ignore", stderr: "ignore" },
  );
  const [saveCode, loadCode] = await Promise.all([save.exited, load.exited]);
  return saveCode === 0 && loadCode === 0;
}

interface InnerRunResult {
  /** Exit code of the *outer* `docker exec ... docker run` invocation. This is
   * the inner container's exit code when the inner `docker run` itself succeeds
   * in starting the container; it can also reflect an outer/exec/daemon failure.
   * Output patterns below disambiguate the two. */
  exitCode: number;
  /** Combined stdout+stderr of the inner run, used to classify *why* a non-zero
   * exit occurred (network failure vs. machinery failure). */
  output: string;
}

/**
 * Run an inner container (via the sidecar's dockerd over `docker exec`) and
 * return its exit code plus combined stdout/stderr. Output is captured (not
 * ignored) so callers can distinguish a network-confinement failure from a
 * machinery failure (missing command, image/exec error, dead inner dockerd).
 *
 * A short connect timeout in the inner command keeps confinement assertions fast
 * and non-flaky: a confined sidecar has no route to the target, so the inner
 * attempt fails (timeout / unreachable / bad address) quickly.
 */
async function innerRun(
  sidecar: string,
  image: string,
  shellCmd: string,
): Promise<InnerRunResult> {
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      sidecar,
      "docker",
      "-H",
      "tcp://127.0.0.1:2375",
      "run",
      "--rm",
      image,
      "sh",
      "-c",
      shellCmd,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

/**
 * Patterns that prove a network *reach* failure (the egress-confinement signal
 * we want), as opposed to a machinery failure. busybox wget wording varies by
 * version, so we match a broad OR set. Case-insensitive.
 *
 * - "bad address" / "could not resolve" / "name does not resolve": DNS failure.
 * - "download timed out" / "timed out": no route -> connect timeout.
 * - "connection refused" / "network unreachable" / "no route to host": L3/L4
 *   reach failure to a raw IP.
 */
const NETWORK_FAILURE_PATTERNS: RegExp[] = [
  /bad address/i,
  /could not resolve/i,
  /name (or service )?(does )?not (known|resolve)/i,
  /name does not resolve/i,
  /temporary failure in name resolution/i,
  /download timed out/i,
  /timed out/i,
  /connection refused/i,
  /network (is )?unreachable/i,
  /no route to host/i,
  /host is unreachable/i,
];

/**
 * Patterns that indicate a *machinery* failure (NOT confinement): the inner
 * command/binary is missing, the image is unusable, or the exec/daemon failed.
 * If the output matches these, a non-zero exit is NOT evidence of confinement.
 */
const MACHINERY_FAILURE_PATTERNS: RegExp[] = [
  /not found/i,
  /no such file or directory/i,
  /executable file not found/i,
  /no such image/i,
  /cannot connect to the docker daemon/i,
  /is the docker daemon running/i,
];

function matchesAny(output: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(output));
}

/**
 * Return the set of docker network names the sidecar is attached to, via
 * `docker inspect`. Used to assert the sidecar is on the session network and not
 * on the default bridge before claiming egress is confined.
 */
async function sidecarNetworks(sidecar: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "docker",
      "inspect",
      "-f",
      "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}",
      sidecar,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [code, out] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  if (code !== 0) return [];
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Pre-pull the inner image on the host once, so the confinement test below can
// side-load it post-severance. Gated on Docker being usable at all.
const innerImageReady =
  dindAvailable && RUNNING_ON_HOST_DOCKER ? await hostPull(INNER_IMAGE) : false;

async function forceCleanup(
  containerName: string,
  networkName: string,
  volumeName: string,
): Promise<void> {
  await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(containerName).catch(() => {});
  await dockerNetworkRemove(networkName).catch(() => {});
  await dockerVolumeRemove(volumeName).catch(() => {});
}

test.skipIf(!dindAvailable || !RUNNING_ON_HOST_DOCKER)(
  "DindStage: non-shared execute sets DOCKER_HOST and teardown removes resources",
  async () => {
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const sharedInput = makeSharedInput(profile);
    const stageState = makeStageState();
    const input = { ...sharedInput, ...stageState };
    const plan = planDind(input, {
      disableCache: true,
      readinessTimeoutMs: 20_000,
    });
    expect(plan).not.toBeNull();

    const containerName = plan!.containerName;
    await forceCleanup(containerName, plan!.networkName, plan!.sharedTmpVolume);

    // In production the (internal) session network is created by the preceding
    // ProxyStage; running DindStage standalone here we must create it ourselves
    // so ensureDindSidecar's `network connect` has a target. Created after the
    // pre-run forceCleanup (which removes any stale copy) so we start clean; the
    // finally-block forceCleanup removes it again at the end.
    await dockerNetworkCreateInternal(plan!.networkName);

    const scope = Effect.runSync(Scope.make());
    try {
      const stage = createDindStageWithOptions(sharedInput, {
        disableCache: true,
        readinessTimeoutMs: 20_000,
      });
      const result = await Effect.runPromise(
        stage
          .run(stageState)
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(DindServiceLive),
          ),
      );

      expect(
        result.container?.env.static.DOCKER_HOST.startsWith("tcp://"),
      ).toEqual(true);
      expect(
        result.container?.env.static.DOCKER_HOST.endsWith(":2375"),
      ).toEqual(true);
      expect(
        typeof result.container?.env.static.NAS_DIND_CONTAINER_NAME,
      ).toEqual("string");
      expect(typeof result.container?.env.static.NAS_DIND_SHARED_TMP).toEqual(
        "string",
      );
      expect(result.dind?.containerName).toEqual(containerName);
      expect(result.container?.network).toBeUndefined();
      expect(result.container?.env.static.DOCKER_HOST).toEqual(
        `tcp://${containerName}:2375`,
      );

      const running = await dockerIsRunning(containerName);
      expect(running).toEqual(true);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      const afterRunning = await dockerIsRunning(containerName);
      try {
        expect(afterRunning).toEqual(false);
      } finally {
        await forceCleanup(
          containerName,
          plan!.networkName,
          plan!.sharedTmpVolume,
        );
      }
    }
  },
  30_000,
);

/**
 * SECURITY regression (R3): a DinD sidecar wired by DindStage is connected to
 * the internal session network and severed from the default bridge, so it has
 * no NAT path out. Inner containers it runs must therefore be unable to reach
 * the outside world — neither a raw IP (DNS-free) nor a DNS name.
 *
 * Why side-load the inner image: after DindStage runs, the sidecar's egress is
 * confined, so an inner `docker pull` would itself fail. We pre-pull on the host
 * and `docker save | docker load` the image into the sidecar (post-severance),
 * which needs no inner network. This is the crux that makes a self-contained
 * confinement test possible.
 */
test.skipIf(!dindAvailable || !RUNNING_ON_HOST_DOCKER || !innerImageReady)(
  "DindStage: inner container egress is confined to the session network (no NAT path out)",
  async () => {
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const sharedInput = makeSharedInput(profile);
    const stageState = makeStageState();
    const plan = planDind(
      { ...sharedInput, ...stageState },
      { disableCache: true, readinessTimeoutMs: 20_000 },
    );
    expect(plan).not.toBeNull();

    const containerName = plan!.containerName;
    await forceCleanup(containerName, plan!.networkName, plan!.sharedTmpVolume);

    // Same standalone-wiring caveat as the test above: create the internal
    // session network ourselves so ensureDindSidecar's connect/sever has a
    // target. forceCleanup (above and in finally) removes it.
    await dockerNetworkCreateInternal(plan!.networkName);

    const scope = Effect.runSync(Scope.make());
    try {
      const stage = createDindStageWithOptions(sharedInput, {
        disableCache: true,
        readinessTimeoutMs: 20_000,
      });
      await Effect.runPromise(
        stage
          .run(stageState)
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(DindServiceLive),
          ),
      );

      // NETWORK-STATE assertion (#4): make the confinement claim self-contained.
      // The sidecar must be attached to the internal session network and NOT to
      // the default bridge; otherwise a non-zero wget below would not prove
      // anything about *this* stage's wiring.
      const networks = await sidecarNetworks(containerName);
      expect(networks).toContain(plan!.networkName);
      expect(networks).not.toContain("bridge");

      // Sidecar is up and (per the test above) bridge-severed / session-net
      // attached at this point. Side-load the inner image without inner network.
      const loaded = await loadImageIntoSidecar(containerName, INNER_IMAGE);
      expect(loaded).toEqual(true);

      // MACHINERY POSITIVE CONTROL (#1/#3): before asserting anything about
      // egress, prove the machinery works. A network-free inner `docker run ...
      // true` MUST exit 0. This confirms the inner dockerd is reachable, the
      // side-loaded image is runnable, and a container actually starts — so any
      // *subsequent* non-zero wget exit is attributable to the network, not to a
      // missing binary / unusable image / dead daemon. If this fails the test is
      // broken upstream of confinement, so we fail hard (not skip).
      const sanity = await innerRun(containerName, INNER_IMAGE, "true");
      expect(
        sanity.exitCode,
        `machinery positive control failed (inner 'docker run ${INNER_IMAGE} true' did not exit 0). ` +
          `This means the test harness is broken upstream of egress confinement, ` +
          `so the egress assertions below would be meaningless. Output:\n${sanity.output}`,
      ).toEqual(0);

      // A second positive control: confirm wget itself exists in the inner image
      // by invoking it with no network (--help). If wget were missing, the
      // confinement probes below would exit non-zero for the WRONG reason.
      const wgetPresent = await innerRun(
        containerName,
        INNER_IMAGE,
        "wget --help >/dev/null 2>&1; echo wget-exit=$?",
      );
      expect(
        wgetPresent.output,
        `wget presence check produced unexpected output:\n${wgetPresent.output}`,
      ).toMatch(/wget-exit=[01]/);
      expect(wgetPresent.output).not.toMatch(/not found/i);

      // EGRESS PROBES: run both probes in ONE inner container (#5) to halve the
      // cold-start cost and stay well under the test timeout. Each probe captures
      // wget's own output (stderr) inline so we can classify the failure.
      //
      //  - http://1.1.1.1/ (raw IP, no DNS): a confined sidecar has no route, so
      //    this must fail with timeout / refused / unreachable.
      //  - http://example.com/ (DNS name): the session network's embedded DNS
      //    does not forward to the internet, so this must fail with a DNS error
      //    ("bad address" / "could not resolve" / ...).
      //
      // We deliberately do NOT redirect wget's stderr to /dev/null here so the
      // failure wording is captured for pattern classification.
      const probe = await innerRun(
        containerName,
        INNER_IMAGE,
        [
          "echo '=== raw-ip ===';",
          "wget -T 3 -q -O- http://1.1.1.1/; echo raw-ip-exit=$?;",
          "echo '=== dns ===';",
          "wget -T 3 -q -O- http://example.com/; echo dns-exit=$?;",
        ].join(" "),
      );

      // The combined run as a whole must have failed (some wget returned
      // non-zero) AND the captured output must look like a network-reach failure,
      // NOT a machinery failure. This AND condition is what defeats the
      // false-positive risk (#1/#2): a missing binary / bad image / dead daemon
      // would either be caught by the positive controls above or surface a
      // machinery pattern here.
      const rawIpFailed = /raw-ip-exit=[^0]/.test(probe.output);
      const dnsFailed = /dns-exit=[^0]/.test(probe.output);
      expect(
        rawIpFailed,
        `raw-IP egress probe did NOT fail as expected (egress may NOT be confined!). Output:\n${probe.output}`,
      ).toEqual(true);
      expect(
        dnsFailed,
        `DNS egress probe did NOT fail as expected (egress may NOT be confined!). Output:\n${probe.output}`,
      ).toEqual(true);

      // The failure must be a *network* failure, not a machinery failure.
      expect(
        matchesAny(probe.output, MACHINERY_FAILURE_PATTERNS),
        `egress probe failed for a MACHINERY reason (missing binary / image / daemon), ` +
          `which is not evidence of confinement. Output:\n${probe.output}`,
      ).toEqual(false);
      expect(
        matchesAny(probe.output, NETWORK_FAILURE_PATTERNS),
        `egress probe failed but output did not match any known network-reach ` +
          `failure pattern, so confinement-by-network cannot be confirmed. Output:\n${probe.output}`,
      ).toEqual(true);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await forceCleanup(
        containerName,
        plan!.networkName,
        plan!.sharedTmpVolume,
      );
    }
  },
  90_000,
);
