import { describe, expect, test } from "bun:test";
import {
  formatTimeRemaining,
  isScheduledSendDue,
  parseTimeInput,
} from "./scheduledSendLogic";

describe("parseTimeInput", () => {
  const base = new Date(2026, 5, 20, 15, 0, 0, 0); // 2026-06-20 15:00:00

  test("parses 24h format '20:10' to correct Date", () => {
    const result = parseTimeInput("20:10", base)!;
    expect(result.getHours()).toBe(20);
    expect(result.getMinutes()).toBe(10);
    expect(result.getSeconds()).toBe(0);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(5);
    expect(result.getDate()).toBe(20);
  });

  test("parses single-digit hour '8:05' to 08:05", () => {
    const result = parseTimeInput("8:05", base)!;
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(5);
    expect(result.getDate()).toBe(21);
  });

  test("past time rolls over to next day", () => {
    const result = parseTimeInput("14:00", base)!;
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(21);
  });

  test("exact current time rolls over to next day", () => {
    const result = parseTimeInput("15:00", base)!;
    expect(result.getDate()).toBe(21);
  });

  test("returns null for invalid input 'abc'", () => {
    expect(parseTimeInput("abc", base)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseTimeInput("", base)).toBeNull();
  });

  test("returns null for out-of-range hours '25:00'", () => {
    expect(parseTimeInput("25:00", base)).toBeNull();
  });

  test("returns null for out-of-range minutes '12:60'", () => {
    expect(parseTimeInput("12:60", base)).toBeNull();
  });

  test("returns null for missing minutes '12'", () => {
    expect(parseTimeInput("12", base)).toBeNull();
  });

  test("returns null for three-digit minutes '12:000'", () => {
    expect(parseTimeInput("12:000", base)).toBeNull();
  });
});

describe("formatTimeRemaining", () => {
  const base = new Date(2026, 5, 20, 15, 0, 0, 0);

  test("formats hours and minutes '1h30m'", () => {
    const target = new Date(base.getTime() + 90 * 60 * 1000);
    expect(formatTimeRemaining(target, base)).toBe("1h30m");
  });

  test("formats minutes and seconds '5m30s'", () => {
    const target = new Date(base.getTime() + (5 * 60 + 30) * 1000);
    expect(formatTimeRemaining(target, base)).toBe("5m30s");
  });

  test("formats seconds only '30s'", () => {
    const target = new Date(base.getTime() + 30 * 1000);
    expect(formatTimeRemaining(target, base)).toBe("30s");
  });

  test("formats zero remaining as '0s'", () => {
    expect(formatTimeRemaining(base, base)).toBe("0s");
  });

  test("formats past time as '0s'", () => {
    const past = new Date(base.getTime() - 60 * 1000);
    expect(formatTimeRemaining(past, base)).toBe("0s");
  });

  test("formats exact hours '2h'", () => {
    const target = new Date(base.getTime() + 2 * 3600 * 1000);
    expect(formatTimeRemaining(target, base)).toBe("2h");
  });

  test("formats hours, minutes and seconds '1h5m10s'", () => {
    const target = new Date(base.getTime() + (3600 + 5 * 60 + 10) * 1000);
    expect(formatTimeRemaining(target, base)).toBe("1h5m10s");
  });
});

describe("isScheduledSendDue", () => {
  const entry = {
    id: "test-1",
    sessionId: "sess-1",
    message: "hello",
    scheduledAt: new Date(2026, 5, 20, 20, 0, 0, 0),
    createdAt: new Date(2026, 5, 20, 15, 0, 0, 0),
  };

  test("returns true when now is after scheduledAt", () => {
    const now = new Date(2026, 5, 20, 20, 0, 1, 0);
    expect(isScheduledSendDue(entry, now)).toBe(true);
  });

  test("returns true when now equals scheduledAt", () => {
    const now = new Date(2026, 5, 20, 20, 0, 0, 0);
    expect(isScheduledSendDue(entry, now)).toBe(true);
  });

  test("returns false when now is before scheduledAt", () => {
    const now = new Date(2026, 5, 20, 19, 59, 59, 0);
    expect(isScheduledSendDue(entry, now)).toBe(false);
  });
});
