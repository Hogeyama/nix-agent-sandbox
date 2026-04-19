/**
 * Pure label/name classifier tests.
 *
 * These functions gate destructive operations (cleanNasContainers etc.), so
 * edge cases — especially the legacy-name fallbacks — are worth pinning down.
 */

import { expect, test } from "bun:test";
import {
  containerNameForSession,
  isLegacyNasSidecarName,
  isLegacyNasTmpVolumeName,
  isNasManagedAgent,
  isNasManagedContainer,
  isNasManagedLabel,
  isNasManagedNetwork,
  isNasManagedSidecar,
  isNasManagedTmpVolume,
  NAS_KIND_AGENT,
  NAS_KIND_DIND,
  NAS_KIND_DIND_NETWORK,
  NAS_KIND_DIND_TMP,
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_KIND_PROXY_NETWORK,
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

test("isNasManagedSidecar: managed + dind/proxy/envoy kind → true", () => {
  for (const kind of [NAS_KIND_DIND, NAS_KIND_PROXY, NAS_KIND_ENVOY]) {
    expect(
      isNasManagedSidecar(
        { [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE, [NAS_KIND_LABEL]: kind },
        "whatever",
      ),
    ).toEqual(true);
  }
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
// isNasManagedTmpVolume
// ---------------------------------------------------------------------------

test("isNasManagedTmpVolume: managed + DIND_TMP kind → true", () => {
  expect(
    isNasManagedTmpVolume(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_DIND_TMP,
      },
      "any",
    ),
  ).toEqual(true);
});

test("isLegacyNasTmpVolumeName: matches -shared-tmp and -tmp- prefix", () => {
  expect(isLegacyNasTmpVolumeName("nas-dind-shared-tmp")).toEqual(true);
  expect(isLegacyNasTmpVolumeName("nas-dind-tmp-xyz")).toEqual(true);
});

test("isLegacyNasTmpVolumeName: false for non-tmp volumes", () => {
  expect(isLegacyNasTmpVolumeName("nas-dind-shared")).toEqual(false);
  expect(isLegacyNasTmpVolumeName("other-vol")).toEqual(false);
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
