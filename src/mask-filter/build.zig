const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});

    // ── shared mask module (maskfs と共用) ──
    const mask_mod = b.createModule(.{
        .root_source_file = b.path("../zig/mask.zig"),
        .target = target,
        .optimize = optimize,
    });

    // ── nas-mask-filter executable ──
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("mask_filter.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    exe_mod.addImport("mask", mask_mod);
    const exe = b.addExecutable(.{
        .name = "nas-mask-filter",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);

    // ── unit tests ──
    const mask_test_mod = b.createModule(.{
        .root_source_file = b.path("../zig/mask.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const test_mod = b.createModule(.{
        .root_source_file = b.path("mask_filter.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addImport("mask", mask_test_mod);
    const unit_tests = b.addTest(.{ .root_module = test_mod });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
