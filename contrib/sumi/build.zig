const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});
    const strip = b.option(bool, "strip", "Strip debug info from the executable") orelse false;
    const version = b.option([]const u8, "version", "Version string shown by --version") orelse "dev";

    const build_options = b.addOptions();
    build_options.addOption([]const u8, "version", version);

    // sumi 実行ファイル。supervise.zig は mask_stream.zig と relay.zig を相対 import
    // しているので、1 つのモジュールとして取り込む (ファイルは 1 モジュールにしか属せない)。
    const mask_mod = b.createModule(.{
        .root_source_file = b.path("../../src/zig/mask.zig"),
        .target = target,
        .optimize = optimize,
    });
    const supervise_mod = b.createModule(.{
        .root_source_file = b.path("../../src/mask-filter/supervise.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    supervise_mod.addImport("mask", mask_mod);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .strip = strip,
    });
    exe_mod.addImport("mask", mask_mod);
    exe_mod.addImport("supervise", supervise_mod);
    exe_mod.addOptions("build_options", build_options);

    const exe = b.addExecutable(.{ .name = "sumi", .root_module = exe_mod });
    b.installArtifact(exe);

    // unit test はクロスターゲットでは走らせられないので、常にホスト向けにビルドする。
    const test_mask_mod = b.createModule(.{
        .root_source_file = b.path("../../src/zig/mask.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const test_supervise_mod = b.createModule(.{
        .root_source_file = b.path("../../src/mask-filter/supervise.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_supervise_mod.addImport("mask", test_mask_mod);
    const test_mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addImport("mask", test_mask_mod);
    test_mod.addImport("supervise", test_supervise_mod);
    test_mod.addOptions("build_options", build_options);
    const unit_tests = b.addTest(.{ .root_module = test_mod });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);

    const extract_mod = b.createModule(.{
        .root_source_file = b.path("claude/extract.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const extract_tests = b.addTest(.{ .root_module = extract_mod });
    test_step.dependOn(&b.addRunArtifact(extract_tests).step);

    // Parity fixtures are explicitly built for development, never installed by
    // the ordinary sumi executable target.
    const fixtures_mod = b.createModule(.{
        .root_source_file = b.path("tests/extract-fixtures.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    fixtures_mod.addImport("extract", extract_mod);
    const fixtures = b.addExecutable(.{ .name = "sumi-extract-fixtures", .root_module = fixtures_mod });
    const install_fixtures = b.addInstallArtifact(fixtures, .{});
    b.step("extract-fixtures", "Build test-only extraction parity fixtures").dependOn(&install_fixtures.step);
}
