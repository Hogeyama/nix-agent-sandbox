# Mask Filter Live Flush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream mask-filter output before EOF for long-running hostexec commands.

**Architecture:** Keep `MaskStream` unchanged and replace only filter mode's buffered stdout writer with the direct file writer. Prove the behavior with the real compiled mask-filter while stdin remains open.

**Tech Stack:** Zig 0.15.2, Bun integration tests

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-13-mask-filter-live-flush-design.md`.
- Follow `skills/test-policy/SKILL.md` and use RED then GREEN.
- Do not change hostexec protocol, Forgejow, serve mode, supervise mode, or `MaskStream` overlap semantics.
- The regression test must use a bounded timeout and clean up the real child process.

---

### Task 1: Stream filter output before EOF

**Files:**
- Modify: `src/stages/maskfs/mask_filter_integration_test.ts`
- Modify: `src/mask-filter/mask_filter.zig`

**Interfaces:**
- Consumes: `MaskStream.streamMask`, `std.fs.File.deprecatedWriter`
- Produces: filter-mode stdout chunks visible before stdin EOF

- [ ] Add a real-binary integration test that writes more than the configured secret overlap but less than 64KiB, keeps stdin open, and fails if no masked stdout arrives within one second.
- [ ] Run the focused test before implementation and confirm timeout failure.
- [ ] Replace filter mode's buffered stdout writer with `stdout.deprecatedWriter()` and remove the now-unused output buffer/final flush.
- [ ] Rebuild the mask-filter and rerun the focused test; confirm it passes.
- [ ] Run the complete mask-filter integration test, `bun run fmt`, `bun run lint`, and `bun run check`.
- [ ] Commit the test and implementation together as one bugfix commit.
