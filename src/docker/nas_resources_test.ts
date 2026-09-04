/**
 * Pure label/name classifier tests.
 *
 * These functions gate destructive operations (cleanNasContainers etc.), so
 * edge cases — especially the legacy-name fallbacks — are worth pinning down.
 */

import { expect, test } from "bun:test";
import {
  containerNameForSession,
  isLegacyNasEphemeralVolumeName,
  isLegacyNasSidecarName,
  isNasManagedAgent,
  isNasManagedContainer,
  isNasManagedEphemeralVolume,
  isNasManagedLabel,
  isNasManagedNetwork,
  isNasManagedSidecar,
  NAS_KIND_AGENT,
  NAS_KIND_DIND,
  NAS_KIND_DIND_DATA,
  NAS_KIND_DIND_NETWORK,
  NAS_KIND_DIND_TMP,
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_KIND_PROXY_NETWORK,
  NAS_KIND_REGISTRY_CACHE,
  NAS_KIND_REGISTRY_MIRROR,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "./nas_resources.ts";

// ---------------------------------------------------------------------------
// containerNameForSession
// ---------------------------------------------------------------------------

test("containerNameForSession: applies the nas-agent- prefix", () => {
  expect(containerNameForSession("abc123")).toEqual("nas-agent-abc123");
});

// ---------------------------------------------------------------------------
// isNasManagedLabel
// ---------------------------------------------------------------------------

test("isNasManagedLabel: true when managed label matches value", () => {
  expect(isNasManagedLabel({ [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE })).toEqual(
    true,
  );
});

test("isNasManagedLabel: false when label is absent or mismatched", () => {
  expect(isNasManagedLabel({})).toEqual(false);
  expect(isNasManagedLabel({ [NAS_MANAGED_LABEL]: "false" })).toEqual(false);
});

// ---------------------------------------------------------------------------
// isNasManagedSidecar
// ---------------------------------------------------------------------------

test("isNasManagedSidecar: managed + dind/proxy kind → true", () => {
  for (const kind of [NAS_KIND_DIND, NAS_KIND_PROXY]) {
    expect(
      isNasManagedSidecar(
        { [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE, [NAS_KIND_LABEL]: kind },
        "whatever",
      ),
    ).toEqual(true);
  }
});

test("isNasManagedSidecar: registry mirror is a managed sidecar", () => {
  expect(
    isNasManagedSidecar(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_MIRROR,
      },
      "nas-registry-mirror-session-a",
    ),
  ).toBe(true);
});

test("isNasManagedSidecar: managed but agent kind → false", () => {
  expect(
    isNasManagedSidecar(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_AGENT,
      },
      "nas-agent-abc",
    ),
  ).toEqual(false);
});

test("isNasManagedSidecar: unmanaged but legacy name → true", () => {
  expect(isNasManagedSidecar({}, "nas-dind-shared")).toEqual(true);
  expect(isNasManagedSidecar({}, "nas-envoy-shared")).toEqual(true);
  expect(isNasManagedSidecar({}, "nas-dind-abc")).toEqual(true);
  expect(isNasManagedSidecar({}, "nas-envoy-abc")).toEqual(true);
  expect(isNasManagedSidecar({}, "nas-proxy-abc")).toEqual(true);
});

test("isNasManagedSidecar: unmanaged and unrelated name → false", () => {
  expect(isNasManagedSidecar({}, "some-other-container")).toEqual(false);
  expect(isNasManagedSidecar({}, "nas-agent-abc")).toEqual(false);
});

test("isLegacyNasSidecarName: tmp-volume suffix is excluded", () => {
  // nas-dind-* but ending in "-tmp" is a volume, not a sidecar.
  expect(isLegacyNasSidecarName("nas-dind-shared-tmp")).toEqual(false);
  expect(isLegacyNasSidecarName("nas-dind-abc-tmp")).toEqual(false);
});

// ---------------------------------------------------------------------------
// isNasManagedNetwork
// ---------------------------------------------------------------------------

test("isNasManagedNetwork: managed + network kinds → true", () => {
  for (const kind of [
    NAS_KIND_DIND_NETWORK,
    NAS_KIND_PROXY_NETWORK,
    NAS_KIND_SESSION_NETWORK,
  ]) {
    expect(
      isNasManagedNetwork(
        { [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE, [NAS_KIND_LABEL]: kind },
        "x",
      ),
    ).toEqual(true);
  }
});

test("isNasManagedNetwork: legacy network names → true", () => {
  expect(isNasManagedNetwork({}, "nas-dind-shared")).toEqual(true);
  expect(isNasManagedNetwork({}, "nas-dind-xyz")).toEqual(true);
  expect(isNasManagedNetwork({}, "nas-session-xyz")).toEqual(true);
  expect(isNasManagedNetwork({}, "nas-proxy-xyz")).toEqual(true);
});

test("isNasManagedNetwork: false for unrelated network name", () => {
  expect(isNasManagedNetwork({}, "bridge")).toEqual(false);
});

// ---------------------------------------------------------------------------
// isNasManagedEphemeralVolume
// ---------------------------------------------------------------------------

test("isNasManagedEphemeralVolume: dind tmp and data are removable", () => {
  for (const kind of [NAS_KIND_DIND_TMP, NAS_KIND_DIND_DATA]) {
    expect(
      isNasManagedEphemeralVolume(
        {
          [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
          [NAS_KIND_LABEL]: kind,
        },
        "any",
      ),
    ).toBe(true);
  }
});

test("isNasManagedEphemeralVolume: registry cache is persistent", () => {
  expect(
    isNasManagedEphemeralVolume(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_CACHE,
      },
      "nas-registry-cache",
    ),
  ).toBe(false);
});

test("isNasManagedEphemeralVolume: unused legacy global dind cache is retired", () => {
  expect(isNasManagedEphemeralVolume({}, "nas-docker-cache")).toBe(true);
  expect(isLegacyNasEphemeralVolumeName("nas-docker-cache")).toBe(true);
});

test("isLegacyNasEphemeralVolumeName: matches tmp volume names", () => {
  expect(isLegacyNasEphemeralVolumeName("nas-dind-shared-tmp")).toEqual(true);
  expect(isLegacyNasEphemeralVolumeName("nas-dind-tmp-xyz")).toEqual(true);
});

test("isLegacyNasEphemeralVolumeName: false for persistent or unrelated volumes", () => {
  expect(isLegacyNasEphemeralVolumeName("nas-dind-shared")).toEqual(false);
  expect(isLegacyNasEphemeralVolumeName("other-vol")).toEqual(false);
});

// ---------------------------------------------------------------------------
// isNasManagedAgent
// ---------------------------------------------------------------------------

test("isNasManagedAgent: true only for managed + AGENT kind", () => {
  expect(
    isNasManagedAgent({
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_AGENT,
    }),
  ).toEqual(true);
  expect(
    isNasManagedAgent({
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND,
    }),
  ).toEqual(false);
  expect(isNasManagedAgent({})).toEqual(false);
});

// ---------------------------------------------------------------------------
// isNasManagedContainer — union of sidecar + agent
// ---------------------------------------------------------------------------

test("isNasManagedContainer: true for any managed sidecar OR managed agent", () => {
  expect(
    isNasManagedContainer(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_AGENT,
      },
      "nas-agent-abc",
    ),
  ).toEqual(true);
  expect(
    isNasManagedContainer(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_DIND,
      },
      "any",
    ),
  ).toEqual(true);
  // Legacy sidecar name alone, no managed label, still matches.
  expect(isNasManagedContainer({}, "nas-dind-abc")).toEqual(true);
});

test("isNasManagedContainer: false for unrelated container", () => {
  expect(isNasManagedContainer({}, "nginx")).toEqual(false);
});
