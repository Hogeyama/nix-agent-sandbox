import { expect, test } from "bun:test";
import type { ContainerInfo } from "../api.ts";
import {
  formatDateTime,
  formatRelativeTime,
  isAckEligibleTurn,
  sortContainers,
  startedTimestamp,
} from "./containersHelpers.ts";

function makeContainer(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    name: "c1",
    running: true,
    labels: {},
    startedAt: "",
    networks: [],
    ...overrides,
  } as ContainerInfo;
}

test("isAckEligibleTurn: user-turn is true", () => {
  expect(isAckEligibleTurn("user-turn")).toBe(true);
});

test("isAckEligibleTurn: ack-turn is true", () => {
  expect(isAckEligibleTurn("ack-turn")).toBe(true);
});

test("isAckEligibleTurn: agent-turn is false", () => {
  expect(isAckEligibleTurn("agent-turn")).toBe(false);
});

test("isAckEligibleTurn: done is false", () => {
  expect(isAckEligibleTurn("done")).toBe(false);
});

test("isAckEligibleTurn: undefined is false", () => {
  expect(isAckEligibleTurn(undefined)).toBe(false);
});

test("startedTimestamp: prefers sessionStartedAt", () => {
  const c = makeContainer({
    sessionStartedAt: "2024-01-02T00:00:00Z",
    startedAt: "2024-01-01T00:00:00Z",
  });
  expect(startedTimestamp(c)).toBe(new Date("2024-01-02T00:00:00Z").getTime());
});

test("startedTimestamp: falls back to startedAt", () => {
  const c = makeContainer({ startedAt: "2024-01-01T00:00:00Z" });
  expect(startedTimestamp(c)).toBe(new Date("2024-01-01T00:00:00Z").getTime());
});

test("startedTimestamp: both undefined returns 0", () => {
  const c = makeContainer({ startedAt: "" });
  // simulate both undefined by clearing the fallback
  const result = startedTimestamp({ ...c, startedAt: "" } as ContainerInfo);
  expect(result).toBe(0);
});

test("startedTimestamp: invalid ISO returns 0", () => {
  const c = makeContainer({ sessionStartedAt: "not-a-date" });
  expect(startedTimestamp(c)).toBe(0);
});

test("sortContainers: most-recently-started first", () => {
  const a = makeContainer({
    name: "a",
    sessionStartedAt: "2024-01-01T00:00:00Z",
  });
  const b = makeContainer({
    name: "b",
    sessionStartedAt: "2024-01-03T00:00:00Z",
  });
  const c = makeContainer({
    name: "c",
    sessionStartedAt: "2024-01-02T00:00:00Z",
  });
  const sorted = sortContainers([a, b, c]);
  expect(sorted.map((x) => x.name)).toEqual(["b", "c", "a"]);
});

test("sortContainers: empty array", () => {
  expect(sortContainers([])).toEqual([]);
});

test("sortContainers: does not mutate input", () => {
  const a = makeContainer({
    name: "a",
    sessionStartedAt: "2024-01-01T00:00:00Z",
  });
  const b = makeContainer({
    name: "b",
    sessionStartedAt: "2024-01-03T00:00:00Z",
  });
  const input = [a, b];
  const inputSnapshot = [...input];
  sortContainers(input);
  expect(input).toEqual(inputSnapshot);
});

test("formatRelativeTime: 30s ago", () => {
  const now = new Date("2024-01-01T00:00:30Z").getTime();
  const iso = "2024-01-01T00:00:00Z";
  expect(formatRelativeTime(iso, now)).toBe("30s ago");
});

test("formatRelativeTime: 5min ago", () => {
  const now = new Date("2024-01-01T00:05:00Z").getTime();
  const iso = "2024-01-01T00:00:00Z";
  expect(formatRelativeTime(iso, now)).toBe("5min ago");
});

test("formatRelativeTime: 2h 30min ago", () => {
  const now = new Date("2024-01-01T02:30:00Z").getTime();
  const iso = "2024-01-01T00:00:00Z";
  expect(formatRelativeTime(iso, now)).toBe("2h 30min ago");
});

test("formatRelativeTime: 1d 5h ago", () => {
  const now = new Date("2024-01-02T05:00:00Z").getTime();
  const iso = "2024-01-01T00:00:00Z";
  expect(formatRelativeTime(iso, now)).toBe("1d 5h ago");
});

test("formatRelativeTime: negative or NaN returns -", () => {
  const now = new Date("2024-01-01T00:00:00Z").getTime();
  // future timestamp -> negative ms
  expect(formatRelativeTime("2024-01-01T01:00:00Z", now)).toBe("-");
  // invalid ISO -> NaN
  expect(formatRelativeTime("not-a-date", now)).toBe("-");
});

test("formatDateTime: undefined returns -", () => {
  expect(formatDateTime(undefined)).toBe("-");
});

test("formatDateTime: invalid ISO returns -", () => {
  expect(formatDateTime("not-a-date")).toBe("-");
});

test("formatDateTime: valid ISO returns non-empty non-dash string", () => {
  const result = formatDateTime("2024-01-01T00:00:00Z");
  expect(result).not.toBe("-");
  expect(result.length).toBeGreaterThan(0);
});
