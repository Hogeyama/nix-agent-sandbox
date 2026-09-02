import { describe, expect, mock, test } from "bun:test";
import { closeDocumentAndRefitTerminal } from "./documentTerminalReturn";

describe("closeDocumentAndRefitTerminal", () => {
  test("closes synchronously and refits the captured handle on the next frame", () => {
    const close = mock(() => undefined);
    const refit = mock(() => undefined);
    const callbacks: Array<() => void> = [];

    closeDocumentAndRefitTerminal({
      activeHandle: { refit },
      close,
      requestAnimationFrame: (callback) => {
        callbacks.push(callback);
        return 1;
      },
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(refit).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.();
    expect(refit).toHaveBeenCalledTimes(1);
  });
});
