const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{});
    const optimize = b.standardOptimizeOption(.{});
    const masking = b.createModule(.{
        .root_source_file = b.path("../masking/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    const supervisor = b.createModule(.{
        .root_source_file = b.path("supervise.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    supervisor.addImport("masking", masking);
    const tests = b.addTest(.{ .root_module = supervisor });
    const run_tests = b.addRunArtifact(tests);
    // std.testing.tmpDir uses the working directory, even with --cache-dir.
    // Keep test scratch files out of read-only source trees in Nix builds.
    run_tests.setCwd(.{ .cwd_relative = b.cache_root.path orelse "." });
    b.step("test", "Run shared process supervisor tests").dependOn(&run_tests.step);
}
