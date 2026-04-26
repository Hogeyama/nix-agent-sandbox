import { describe, expect, test } from "bun:test";
import {
  initialRenameState,
  type RenameState,
  reduceRenameState,
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
