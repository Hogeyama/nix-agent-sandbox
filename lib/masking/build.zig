const std = @import("std");

pub fn build(b: *std.Build) void {
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("root.zig"),
            .target = b.resolveTargetQuery(.{}),
            .optimize = b.standardOptimizeOption(.{}),
        }),
    });
    const run_tests = b.addRunArtifact(tests);
    // std.testing.tmpDir uses the working directory, even with --cache-dir.
    // Keep test scratch files out of read-only source trees in Nix builds.
    run_tests.setCwd(.{ .cwd_relative = b.cache_root.path orelse "." });
    b.step("test", "Run shared masking tests").dependOn(&run_tests.step);
}
