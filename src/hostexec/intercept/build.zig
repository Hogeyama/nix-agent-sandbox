const std = @import("std");

fn testToolPath(b: *std.Build, bin_dir: []const u8, comptime name: []const u8, comptime host_path: []const u8) []const u8 {
    if (bin_dir.len == 0) return host_path;
    return b.fmt("{s}/{s}", .{ bin_dir, name });
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const test_bin_dir = b.option([]const u8, "test-bin-dir", "Directory containing hostexec test executables") orelse "";
    const test_options = b.addOptions();
    test_options.addOption([]const u8, "bin_dir", test_bin_dir);
    test_options.addOption([]const u8, "true_path", testToolPath(b, test_bin_dir, "true", "/bin/true"));
    test_options.addOption([]const u8, "sh_path", testToolPath(b, test_bin_dir, "sh", "/bin/sh"));
    test_options.addOption([]const u8, "cat_path", testToolPath(b, test_bin_dir, "cat", "/bin/cat"));
    test_options.addOption([]const u8, "ls_path", testToolPath(b, test_bin_dir, "ls", "/bin/ls"));
    test_options.addOption([]const u8, "sleep_path", testToolPath(b, test_bin_dir, "sleep", "/bin/sleep"));
    test_options.addOption([]const u8, "env_path", testToolPath(b, test_bin_dir, "env", "/usr/bin/env"));
    const test_options_module = test_options.createModule();

    const host_target = b.resolveTargetQuery(.{});

    // ── shared library ──
    //
    // Forced onto glibc, pinned to an ancient version. Same shape as the
    // client below, opposite libc: the .so is LD_PRELOADed into processes the
    // sandbox does not pick, so it must match *their* libc rather than carry
    // its own. Every agent image nas builds on is glibc, which makes `.gnu`
    // the only ABI worth emitting — and leaving the ABI to `-Dtarget` emits a
    // musl .so for a bare `x86_64-linux` (Zig's default ABI), an interceptor
    // that no glibc process can load at all.
    //
    // The version pin covers the other half. Those processes come from the
    // image and from whatever /nix closures the host mounts in, some built
    // against a glibc far older than the build machine's. A native build asks
    // for the *build* host's symbols (`dlsym@GLIBC_2.34`,
    // `fstat@GLIBC_2.33`), and the loader then refuses every such process with
    // "version `GLIBC_2.34' not found" — killing not just hostexec but every
    // command under the preload. 2.17 keeps Zig on the symbols glibc has
    // exported since RHEL 7; a newer glibc still resolves those through its
    // compat versions.
    var lib_query = target.query;
    lib_query.abi = .gnu;
    lib_query.setGnuLibCVersion(2, 17, 0);
    const lib_target = b.resolveTargetQuery(lib_query);
    const lib_mod = b.createModule(.{
        .root_source_file = b.path("hostexec_intercept.zig"),
        .target = lib_target,
        .optimize = optimize,
        .link_libc = true,
    });
    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "hostexec_intercept",
        .root_module = lib_mod,
    });

    b.installArtifact(lib);

    // ── standalone client ──
    //
    // Statically linked against musl. This binary is bind-mounted into the
    // agent container and invoked through the wrapper symlinks, so it must run
    // whatever the image's libc is — or whether it has one at all. The .so
    // above cannot do the same: it is loaded into processes that are already
    // linked against the image's libc.
    // Same target as the .so, only forced onto musl — so `-Dtarget` still
    // cross-compiles both artifacts for the same machine.
    var client_query = target.query;
    client_query.abi = .musl;
    // `-Dtarget=x86_64-linux-gnu.2.28` parses that suffix into `glibc_version`,
    // which then rides along onto the musl query and is rejected as
    // `x86_64-linux-musl.2.28: InvalidAbiVersion`. The suffix constrains the
    // .so above; it means nothing here.
    client_query.glibc_version = null;
    const client_target = b.resolveTargetQuery(client_query);
    const client_mod = b.createModule(.{
        .root_source_file = b.path("client_main.zig"),
        .target = client_target,
        .optimize = optimize,
        .link_libc = true,
    });
    const client = b.addExecutable(.{
        .name = "nas-hostexec-client",
        .root_module = client_mod,
    });
    client.linkage = .static;

    b.installArtifact(client);

    // ── per-session host gateway ──
    const gateway_mod = b.createModule(.{
        .root_source_file = b.path("gateway_main.zig"),
        .target = client_target,
        .optimize = optimize,
        .link_libc = true,
    });
    gateway_mod.addImport("hostexec_test_options", test_options_module);
    const gateway = b.addExecutable(.{
        .name = "nas-hostexec-gateway",
        .root_module = gateway_mod,
    });
    gateway.linkage = .static;
    b.installArtifact(gateway);

    // ── unit tests (use host target so tests can run in Nix sandbox) ──
    //
    // The root pulls in protocol.zig and client_main.zig via an `_ = @import`
    // test block, so this single step covers all three modules.
    const test_mod = b.createModule(.{
        .root_source_file = b.path("hostexec_intercept.zig"),
        .target = host_target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addImport("hostexec_test_options", test_options_module);

    const unit_tests = b.addTest(.{
        .root_module = test_mod,
    });

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
