import { describe, expect, test } from "bun:test";
import { lampOf, maxLamp } from "./sessionLamp";
import type { PendingCount } from "./sessionPendingSummary";

const zero: PendingCount = { network: 0, hostexec: 0 };

function pendingForFromMap(
  map: Record<string, PendingCount>,
): (sessionId: string) => PendingCount {
  return (id) => map[id] ?? zero;
}

describe("lampOf", () => {
  test("pending wins when network count is positive", () => {
    const lamp = lampOf(
      { sessionId: "sA", turn: "agent-turn" },
      pendingForFromMap({ sA: { network: 1, hostexec: 0 } }),
    );
    expect(lamp).toBe("pending");
  });

  test("pending wins when only hostexec count is positive", () => {
    const lamp = lampOf(
      { sessionId: "sA", turn: null },
      pendingForFromMap({ sA: { network: 0, hostexec: 2 } }),
    );
    expect(lamp).toBe("pending");
  });

  test("pending wins over user-turn for the same session", () => {
    const lamp = lampOf(
      { sessionId: "sA", turn: "user-turn" },
      pendingForFromMap({ sA: { network: 1, hostexec: 0 } }),
    );
    expect(lamp).toBe("pending");
  });

  test("user-turn lamp when no pending and turn is user-turn", () => {
    const lamp = lampOf(
      { sessionId: "sA", turn: "user-turn" },
      pendingForFromMap({}),
    );
    expect(lamp).toBe("user-turn");
  });

  test("none lamp when turn is agent-turn and no pending", () => {
    const lamp = lampOf(
      { sessionId: "sA", turn: "agent-turn" },
      pendingForFromMap({}),
    );
    expect(lamp).toBe("none");
  });

  test("zero record from pendingFor is not treated as pending", () => {
    const lamp = lampOf(
      { sessionId: "sA", turn: "agent-turn" },
      pendingForFromMap({ sA: zero }),
    );
    expect(lamp).toBe("none");
  });

  test("null turn falls through to none when no pending", () => {
    const lamp = lampOf({ sessionId: "sA", turn: null }, pendingForFromMap({}));
    expect(lamp).toBe("none");
  });
});

describe("maxLamp", () => {
  test("empty session list returns none", () => {
    expect(maxLamp([], pendingForFromMap({}))).toBe("none");
  });

  test("single session pending → pending", () => {
    expect(
      maxLamp(
        [{ sessionId: "sA", turn: "agent-turn" }],
        pendingForFromMap({ sA: { network: 1, hostexec: 0 } }),
      ),
    ).toBe("pending");
  });

  test("single session user-turn with no pending → user-turn", () => {
    expect(
      maxLamp([{ sessionId: "sA", turn: "user-turn" }], pendingForFromMap({})),
    ).toBe("user-turn");
  });

  test("single session agent-turn → none", () => {
    expect(
      maxLamp([{ sessionId: "sA", turn: "agent-turn" }], pendingForFromMap({})),
    ).toBe("none");
  });

  test("one pending among agent-turns wins", () => {
    expect(
      maxLamp(
        [
          { sessionId: "sA", turn: "agent-turn" },
          { sessionId: "sB", turn: "agent-turn" },
          { sessionId: "sC", turn: "agent-turn" },
        ],
        pendingForFromMap({ sB: { network: 0, hostexec: 1 } }),
      ),
    ).toBe("pending");
  });

  test("all user-turn → user-turn", () => {
    expect(
      maxLamp(
        [
          { sessionId: "sA", turn: "user-turn" },
          { sessionId: "sB", turn: "user-turn" },
        ],
        pendingForFromMap({}),
      ),
    ).toBe("user-turn");
  });

  test("one user-turn among idle sessions → user-turn", () => {
    expect(
      maxLamp(
        [
          { sessionId: "sA", turn: "agent-turn" },
          { sessionId: "sB", turn: "user-turn" },
          { sessionId: "sC", turn: "done" },
        ],
        pendingForFromMap({}),
      ),
    ).toBe("user-turn");
  });

  test("pending and user-turn mixed → pending wins", () => {
    expect(
      maxLamp(
        [
          { sessionId: "sA", turn: "user-turn" },
          { sessionId: "sB", turn: "agent-turn" },
        ],
        pendingForFromMap({ sB: { network: 1, hostexec: 0 } }),
      ),
    ).toBe("pending");
  });

  test("pending found early returns immediately (does not require full scan)", () => {
    // The first session is pending; a later "user-turn" session must
    // not down-grade the result. This is the early-return contract
    // exercised behaviourally — `pending` always wins.
    expect(
      maxLamp(
        [
          { sessionId: "sA", turn: "agent-turn" },
          { sessionId: "sB", turn: "user-turn" },
        ],
        pendingForFromMap({ sA: { network: 1, hostexec: 0 } }),
      ),
    ).toBe("pending");
  });

  test("zero pending records and idle turns → none", () => {
    expect(
      maxLamp(
        [
          { sessionId: "sA", turn: "agent-turn" },
          { sessionId: "sB", turn: "done" },
        ],
        pendingForFromMap({ sA: zero, sB: zero }),
      ),
    ).toBe("none");
  });
});
