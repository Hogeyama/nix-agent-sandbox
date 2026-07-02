const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});

    // ── unit tests (mask.zig は FUSE 非依存) ──
    const mask_test_mod = b.createModule(.{
        .root_source_file = b.path("mask.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const mask_tests = b.addTest(.{ .root_module = mask_test_mod });
    const run_mask_tests = b.addRunArtifact(mask_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_mask_tests.step);

    _ = target; // Task 3 で executable に使用
}
