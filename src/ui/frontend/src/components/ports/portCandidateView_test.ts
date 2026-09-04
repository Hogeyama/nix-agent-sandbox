import { expect, test } from "bun:test";
import type { PortCandidate } from "../../api/client";
import { candidateRows, watchNotice } from "./portCandidateView";

function candidate(
  containerPort: number,
  scope: PortCandidate["scope"],
): PortCandidate {
  return {
    containerPort,
    scope,
    reachable: scope === "any" || scope === "loopback",
  };
}

test("reachable ports are listed in port order without a hint", () => {
  expect(
    candidateRows([candidate(5173, "any"), candidate(3000, "loopback")]),
  ).toEqual([
    { containerPort: 3000, hint: null },
    { containerPort: 5173, hint: null },
  ]);
});

test("a port bound elsewhere says which address it picked", () => {
  const [ipv6, external] = candidateRows([
    candidate(3000, "loopback6"),
    candidate(8080, "remote"),
  ]);
  expect(ipv6.hint).toContain("::1");
  expect(external.hint).toContain("0.0.0.0");
});

test("an empty scan is silent, but an unusable one says why", () => {
  expect(watchNotice("watching")).toEqual(null);
  expect(watchNotice(null)).toEqual(null);
  expect(watchNotice("container-not-running")).toContain("not running");
  expect(watchNotice("relay-unreachable")).toContain("Cannot reach");
});
