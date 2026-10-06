import { expect, test } from "bun:test";
import { terminalSequence } from "./notify.ts";

test("the terminal gets an OSC 9 notification naming the session", () => {
  expect(terminalSequence({ id: "calm-fox" }, "terminal")).toBe(
    "\x1b]9;strait calm-fox: approval needed\x07",
  );
});

test("inside tmux the notification is wrapped for passthrough", () => {
  expect(terminalSequence({ id: "calm-fox", tmuxPane: "%3" }, "terminal")).toBe(
    "\x1bPtmux;\x1b\x1b]9;strait calm-fox: approval needed\x07\x1b\\",
  );
});

test("nothing but printable ASCII reaches the terminal", () => {
  expect(terminalSequence({ id: "a\x07\x1b]b‮" }, "terminal")).toBe(
    "\x1b]9;strait a??]b?: approval needed\x07",
  );
});

test("bell is a bare BEL, which tmux passes on by itself", () => {
  expect(terminalSequence({ id: "calm-fox", tmuxPane: "%3" }, "bell")).toBe(
    "\x07",
  );
});
