import { describe, expect, test } from "bun:test";
import { getInfo } from "./info.ts";

describe("getInfo", () => {
  test("returns HOME when set to a non-empty string", () => {
    expect(getInfo({ HOME: "/home/foo" })).toEqual({ home: "/home/foo" });
  });

  test("returns null when HOME is unset", () => {
    expect(getInfo({})).toEqual({ home: null });
  });

  test("treats empty-string HOME as unset", () => {
    expect(getInfo({ HOME: "" })).toEqual({ home: null });
  });
});
