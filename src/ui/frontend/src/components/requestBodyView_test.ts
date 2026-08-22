import { describe, expect, test } from "bun:test";
import { displayRequestBody } from "./requestBodyView";

describe("displayRequestBody", () => {
  test("decodes valid UTF-8 bytes for text display", () => {
    const data = btoa(
      String.fromCharCode(...new TextEncoder().encode("こんにちは\n")),
    );

    expect(displayRequestBody(data)).toEqual({
      encoding: "utf-8",
      text: "こんにちは\n",
    });
  });

  test("preserves the original base64 when bytes are not valid UTF-8", () => {
    const data = "/4A=";

    expect(displayRequestBody(data)).toEqual({
      encoding: "base64",
      text: data,
    });
  });
});
