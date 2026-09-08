const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});

    // ── Create shared mask module (for both maskfs and mask-filter to use) ──
    const mask_mod = b.createModule(.{
        .root_source_file = b.path("../zig/mask.zig"),
        .target = target,
        .optimize = optimize,
    });

    // ── nas-maskfs executable ──
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("maskfs.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    exe_mod.addImport("mask", mask_mod);
    const exe = b.addExecutable(.{
        .name = "nas-maskfs",
        .root_module = exe_mod,
    });
    exe.linkSystemLibrary("fuse3");
    b.installArtifact(exe);

    // ── unit tests (mask.zig は FUSE 非依存) ──
    const mask_test_mod = b.createModule(.{
        .root_source_file = b.path("../zig/mask.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const mask_tests = b.addTest(.{ .root_module = mask_test_mod });
    const run_mask_tests = b.addRunArtifact(mask_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_mask_tests.step);
}
