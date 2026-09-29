const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.resolveTargetQuery(.{});
    const strip = b.option(bool, "strip", "Strip debug info from the executable") orelse false;
    const version = b.option([]const u8, "version", "Version string shown by --version") orelse "dev";

    const build_options = b.addOptions();
    build_options.addOption([]const u8, "version", version);

    // `sumi --licenses` の本文。sumi が単体の実行ファイルで配られても表示が
    // 付いていくよう、埋め込む。musl の COPYRIGHT は、実際にリンクする Zig 同梱の
    // musl から取る。Zig 本体の LICENSE はインストール先に無いので複製を置き、
    // Nix ビルドで Zig の source と一致することを確かめる。
    const notices = b.addWriteFiles();
    _ = notices.addCopyFile(b.path("../../LICENSE"), "sumi-LICENSE");
    _ = notices.addCopyFile(b.path("licenses/zig-LICENSE"), "zig-LICENSE");
    _ = notices.addCopyFile(.{ .cwd_relative = b.graph.zig_lib_directory.join(b.allocator, &.{ "libc", "musl", "COPYRIGHT" }) catch @panic("OOM") }, "musl-COPYRIGHT");
    const licenses_mod = b.createModule(.{
        .root_source_file = notices.add("licenses.zig",
            \\pub const sumi = @embedFile("sumi-LICENSE");
            \\pub const zig = @embedFile("zig-LICENSE");
            \\pub const musl = @embedFile("musl-COPYRIGHT");
            \\
        ),
    });

    // Shared libraries are independent of the nas executable sources.
    const mask_mod = b.createModule(.{
        .root_source_file = b.path("../../lib/masking/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    const supervise_mod = b.createModule(.{
        .root_source_file = b.path("../../lib/process-supervisor/supervise.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    supervise_mod.addImport("masking", mask_mod);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .strip = strip,
    });
    exe_mod.addImport("masking", mask_mod);
    exe_mod.addImport("supervise", supervise_mod);
    exe_mod.addOptions("build_options", build_options);
    exe_mod.addImport("licenses", licenses_mod);

    const exe = b.addExecutable(.{ .name = "sumi", .root_module = exe_mod });
    b.installArtifact(exe);

    // unit test はクロスターゲットでは走らせられないので、常にホスト向けにビルドする。
    const test_mask_mod = b.createModule(.{
        .root_source_file = b.path("../../lib/masking/root.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const test_supervise_mod = b.createModule(.{
        .root_source_file = b.path("../../lib/process-supervisor/supervise.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_supervise_mod.addImport("masking", test_mask_mod);
    const test_mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addImport("masking", test_mask_mod);
    test_mod.addImport("supervise", test_supervise_mod);
    test_mod.addOptions("build_options", build_options);
    test_mod.addImport("licenses", licenses_mod);
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
