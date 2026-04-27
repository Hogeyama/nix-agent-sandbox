/**
 * Tests for `terminalToolbarLogic`.
 *
 * The pure helpers here back the toolbar's Ack-turn visibility,
 * font-size clamping, and search-submit decision. Every behaviour
 * the component depends on is pinned at this layer so the Solid
 * shell can stay rendering-only.
 */

import { describe, expect, test } from "bun:test";
import { HttpError } from "../api/client";
import {
  clampFontSize,
  decideSearchSubmit,
  describeAckButton,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  shouldSurfaceAckError,
} from "./terminalToolbarLogic";

describe("describeAckButton", () => {
  test("hidden when turn is not user-turn", () => {
    for (const turn of ["agent-turn", "ack-turn", "done", null, undefined]) {
      const state = describeAckButton(turn, false);
      expect(state.visible).toBe(false);
    }
  });

  test("visible and enabled on user-turn while idle", () => {
    const state = describeAckButton("user-turn", false);
    expect(state).toEqual({
      visible: true,
      disabled: false,
      label: "Ack turn",
    });
  });

  test("visible and disabled on user-turn while a request is in flight", () => {
    const state = describeAckButton("user-turn", true);
    expect(state).toEqual({ visible: true, disabled: true, label: "Ack turn" });
  });
});

describe("clampFontSize", () => {
  test("clamps below the lower bound up to FONT_SIZE_MIN", () => {
    expect(clampFontSize(8)).toBe(FONT_SIZE_MIN);
  });

  test("clamps above the upper bound down to FONT_SIZE_MAX", () => {
    expect(clampFontSize(40)).toBe(FONT_SIZE_MAX);
  });

  test("passes a value within range through unchanged", () => {
    expect(clampFontSize(16)).toBe(16);
  });

  test("non-finite inputs collapse to FONT_SIZE_DEFAULT", () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT);
  });
});

describe("decideSearchSubmit", () => {
  test("empty or whitespace-only query maps to clear", () => {
    expect(decideSearchSubmit("", false)).toBe("clear");
    expect(decideSearchSubmit("   ", false)).toBe("clear");
    expect(decideSearchSubmit("", true)).toBe("clear");
  });

  test("non-empty query without Shift requests next", () => {
    expect(decideSearchSubmit("foo", false)).toBe("next");
  });

  test("non-empty query with Shift requests prev", () => {
    expect(decideSearchSubmit("foo", true)).toBe("prev");
  });
});

describe("shouldSurfaceAckError", () => {
  test("HttpError 409 is silent (stale snapshot raced the ack)", () => {
    expect(shouldSurfaceAckError(new HttpError(409, "conflict"))).toBe(false);
  });

  test("HttpError 400 is surfaced", () => {
    expect(shouldSurfaceAckError(new HttpError(400, "bad request"))).toBe(true);
  });

  test("HttpError 500 is surfaced", () => {
    expect(shouldSurfaceAckError(new HttpError(500, "server error"))).toBe(
      true,
    );
  });

  test("generic Error is surfaced", () => {
    expect(shouldSurfaceAckError(new Error("network down"))).toBe(true);
  });
});
