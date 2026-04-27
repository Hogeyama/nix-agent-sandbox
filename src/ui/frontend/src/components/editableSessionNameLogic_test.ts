import { describe, expect, test } from "bun:test";
import {
  initialRenameState,
  NAME_MAX_LENGTH,
  type RenameState,
  reduceRenameState,
  validateName,
} from "./editableSessionNameLogic";

describe("reduceRenameState", () => {
  test("start transitions idle to editing with current name as draft", () => {
    const next = reduceRenameState(initialRenameState, {
      type: "start",
      current: "foo",
    });
    expect(next).toEqual({ mode: "editing", draft: "foo" });
  });

  test("change updates draft while in editing", () => {
    const editing: RenameState = { mode: "editing", draft: "foo" };
    const next = reduceRenameState(editing, { type: "change", draft: "bar" });
    expect(next).toEqual({ mode: "editing", draft: "bar" });
  });

  test("change is a noop when not in editing", () => {
    const saving: RenameState = { mode: "saving", draft: "foo" };
    const next = reduceRenameState(saving, { type: "change", draft: "bar" });
    expect(next).toBe(saving);
  });

  test("commit transitions editing to saving and preserves the draft", () => {
    const editing: RenameState = { mode: "editing", draft: "foo" };
    const next = reduceRenameState(editing, { type: "commit" });
    expect(next).toEqual({ mode: "saving", draft: "foo" });
  });

  test("success transitions saving back to idle", () => {
    const saving: RenameState = { mode: "saving", draft: "foo" };
    const next = reduceRenameState(saving, { type: "success" });
    expect(next).toEqual({ mode: "idle" });
  });

  test("failure transitions saving back to editing with the error preserved", () => {
    const saving: RenameState = { mode: "saving", draft: "foo" };
    const next = reduceRenameState(saving, {
      type: "failure",
      error: "boom",
    });
    expect(next).toEqual({ mode: "editing", draft: "foo", error: "boom" });
  });

  test("cancel from any state returns to idle", () => {
    expect(
      reduceRenameState({ mode: "editing", draft: "foo" }, { type: "cancel" }),
    ).toEqual({ mode: "idle" });
    expect(
      reduceRenameState({ mode: "saving", draft: "foo" }, { type: "cancel" }),
    ).toEqual({ mode: "idle" });
    expect(reduceRenameState(initialRenameState, { type: "cancel" })).toEqual({
      mode: "idle",
    });
  });

  test("commit is a no-op from idle", () => {
    const state: RenameState = { mode: "idle" };
    expect(reduceRenameState(state, { type: "commit" })).toBe(state);
  });

  test("commit is a no-op from saving", () => {
    const state: RenameState = { mode: "saving", draft: "x" };
    expect(reduceRenameState(state, { type: "commit" })).toBe(state);
  });

  test("success is a no-op from idle", () => {
    const state: RenameState = { mode: "idle" };
    expect(reduceRenameState(state, { type: "success" })).toBe(state);
  });

  test("success is a no-op from editing", () => {
    const state: RenameState = { mode: "editing", draft: "x" };
    expect(reduceRenameState(state, { type: "success" })).toBe(state);
  });

  test("failure is a no-op from idle", () => {
    const state: RenameState = { mode: "idle" };
    expect(reduceRenameState(state, { type: "failure", error: "e" })).toBe(
      state,
    );
  });

  test("failure is a no-op from editing", () => {
    const state: RenameState = { mode: "editing", draft: "x" };
    expect(reduceRenameState(state, { type: "failure", error: "e" })).toBe(
      state,
    );
  });

  test("start from editing overwrites with fresh draft", () => {
    const state: RenameState = { mode: "editing", draft: "stale" };
    expect(
      reduceRenameState(state, { type: "start", current: "fresh" }),
    ).toEqual({ mode: "editing", draft: "fresh" });
  });

  test("start from saving overwrites with fresh draft", () => {
    const state: RenameState = { mode: "saving", draft: "x" };
    expect(
      reduceRenameState(state, { type: "start", current: "fresh" }),
    ).toEqual({ mode: "editing", draft: "fresh" });
  });
});

describe("validateName", () => {
  test("rejects non-string input", () => {
    expect(validateName(123 as unknown as string)).toEqual({
      ok: false,
      reason: "Name must be a string",
    });
  });

  test("trims surrounding whitespace", () => {
    expect(validateName("  foo  ")).toEqual({ ok: true, value: "foo" });
  });

  test("rejects input that is empty after trim", () => {
    expect(validateName("   ")).toEqual({
      ok: false,
      reason: "Name cannot be empty",
    });
  });

  test("rejects input that exceeds NAME_MAX_LENGTH after trim", () => {
    const tooLong = "a".repeat(NAME_MAX_LENGTH + 1);
    expect(validateName(tooLong)).toEqual({
      ok: false,
      reason: `Name exceeds ${NAME_MAX_LENGTH} characters`,
    });
  });

  test("strips ASCII control characters before trimming", () => {
    expect(validateName("a\x00b\x1Fc\x7Fd")).toEqual({
      ok: true,
      value: "abcd",
    });
  });

  test("preserves valid unicode (e.g. Japanese)", () => {
    expect(validateName("テスト")).toEqual({ ok: true, value: "テスト" });
  });

  test("accepts an input that is exactly NAME_MAX_LENGTH after trim", () => {
    const exact = "a".repeat(NAME_MAX_LENGTH);
    expect(validateName(exact)).toEqual({ ok: true, value: exact });
  });

  test("rejects input that contains only control characters", () => {
    expect(validateName("\x00\x01\x02")).toEqual({
      ok: false,
      reason: "Name cannot be empty",
    });
  });
});
