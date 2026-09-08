import { expect, test } from "bun:test";
import { maskNonCode, moduleReferences } from "./pkl_source.ts";

test("module references retain URI literals through comments and string delimiters", () => {
  expect(
    moduleReferences(`amends /* note */ "modulepath:/global.pkl"
import ##"other.pkl"##
local moduleValue = import("inline.pkl")
local text = "\\(import("interpolated.pkl"))"
import """
multiline.pkl
"""
`),
  ).toEqual([
    "modulepath:/global.pkl",
    "other.pkl",
    "inline.pkl",
    "interpolated.pkl",
    "multiline.pkl",
  ]);
});

test("module references ignore commented tokens and literal examples", () => {
  expect(
    moduleReferences(String.raw`/*
import "modulepath:/global.pkl"
*/
// amends "modulepath:/global.pkl"
local normal = "import \"modulepath:/global.pkl\""
local raw = ##"import "modulepath:/global.pkl""##
local multiline = """
import "modulepath:/global.pkl"
"""
local rawMultiline = ##"""
amends "modulepath:/global.pkl"
"""##
local notimport = "modulepath:/global.pkl"
`),
  ).toEqual([]);
});

test("masking preserves source offsets before module URI literals", () => {
  const source = '/* 🌍 */ import "modulepath:/global.pkl"';
  expect(maskNonCode(source).length).toBe(source.length);
  expect(moduleReferences(source)).toEqual(["modulepath:/global.pkl"]);
});
