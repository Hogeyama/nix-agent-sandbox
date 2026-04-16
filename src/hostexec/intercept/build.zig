const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const host_target = b.resolveTargetQuery(.{});

    // ── shared library ──
    const lib_mod = b.createModule(.{
        .root_source_file = b.path("hostexec_intercept.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "hostexec_intercept",
        .root_module = lib_mod,
    });

    b.installArtifact(lib);

    // ── unit tests (use host target so tests can run in Nix sandbox) ──
    const test_mod = b.createModule(.{
        .root_source_file = b.path("hostexec_intercept.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });

    const unit_tests = b.addTest(.{
        .root_module = test_mod,
    });

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
