const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});
    const version = b.option([]const u8, "version", "Version string shown by --version") orelse "dev";

    const build_options = b.addOptions();
    build_options.addOption([]const u8, "version", version);

    // ── Create shared mask module (for both maskfs and mask-filter to use) ──
    const mask_mod = b.createModule(.{
        .root_source_file = b.path("../../lib/masking/root.zig"),
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
    exe_mod.addImport("masking", mask_mod);
    exe_mod.addOptions("build_options", build_options);
    const exe = b.addExecutable(.{
        .name = "nas-maskfs",
        .root_module = exe_mod,
    });
    exe.linkSystemLibrary("fuse3");
    b.installArtifact(exe);

    // Compatibility test entry point: the shared masking suite, without FUSE.
    // maskfs itself is covered by tests/maskfs_e2e_test.ts.
    const mask_test_mod = b.createModule(.{
        .root_source_file = b.path("../../lib/masking/root.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const mask_tests = b.addTest(.{ .root_module = mask_test_mod });
    const run_mask_tests = b.addRunArtifact(mask_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_mask_tests.step);
}
