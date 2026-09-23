{ pkgs
, system
, self
, nixpkgs
, bun2nix
, nix-bundle-elf
, nasUnwrapped
, rawPayload
, pklVersion
, pklBinaryPin
, pklNative
, dtachMarked
, hostexecIntercept
, maskfs
, maskFilter
, mitmproxyVendor
, nasAssetsBase
}:

let
  nodeHeaders = pkgs.fetchurl {
    url = "https://nodejs.org/dist/v26.3.0/node-v26.3.0-headers.tar.gz";
    hash = "sha256-/KETxdWt2L+xqjESmiSsuNSappqzwiosxWmuyIlgUm0=";
  };
  rustSource = pkgs.fetchurl {
    url = "https://static.rust-lang.org/dist/2026-07-20/rust-src-nightly.tar.xz";
    hash = "sha256-1P/lfMmdiEZ2G9vvxjG/2PBvwAHXIIV2iH44HFcJNBo=";
  };
  policy = builtins.fromJSON (builtins.readFile ./policy.json);
  bunSource = pkgs.fetchurl {
    name = "bun.tar.gz";
    url = "https://github.com/oven-sh/bun/archive/bun-v${pkgs.bun.version}.tar.gz";
    hash = "sha256-4UZwsRfWkBLYKFFNZX8KMTPRwl0T1pRhGE0FtqjpqHY=";
  };
  # The upstream definitions determine the complete source set. Only its
  # aggregate hash is maintained here; generated manifests stay in the store.
  runtimeSources = pkgs.runCommand "nas-runtime-sources-bun-${pkgs.bun.version}-pkl-${pklVersion}" {
    nativeBuildInputs = [ pkgs.bun pkgs.curl pkgs.gitMinimal pkgs.gnutar pkgs.gzip ];
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-2yXvFBu4PG+YOlzICV3OHrkpbh+VgzbYNDY6r/P6C7g=";
    impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars;
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
    GIT_SSL_CAINFO = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  } ''
    mkdir bun pkl "$out"
    tar -xzf ${bunSource} --strip-components=1 -C bun
    tar -xzf ${pklSource} --strip-components=1 -C pkl
    cp ${bunSource} "$out/bun.tar.gz"
    cp ${../../scripts/release/fetch_sources.ts} fetch_sources.ts
    cp ${../../scripts/release/bun_npm.ts} bun_npm.ts
    bun fetch_sources.ts "$PWD/bun" "$PWD/pkl" "$out"
  '';

  # GitHub's generated archive endpoint rejects this large fork at the pinned
  # commit. Fetch the exact Git object tree instead of substituting WebKit
  # upstream or a moving branch. The hash is filled from that tree, not the
  # prebuilt WebKit archive used by the official Bun release.
  webkitRevision = "2e2aa2290fac856d6f451ceacb58f7f5b44dd057";
  webkitSource = pkgs.fetchgit {
    url = "https://github.com/oven-sh/WebKit.git";
    rev = webkitRevision;
    hash = "sha256-EJsxFF2NIROfGkvlXTKRR+MSO1fFwquZaqD9G4gvzuU=";
    fetchSubmodules = false;
  };
  pklSource = pkgs.fetchurl {
    name = "pkl-source.tar.gz";
    url = "https://github.com/apple/pkl/archive/refs/tags/${pklVersion}.tar.gz";
    hash = "sha256-XdIxgHoWcoO7n9Z7LGuIeK1ACO+3eAzondP1u7vKgNc=";
  };
  icuSource = pkgs.fetchurl {
    name = "icu-release-78.3.tar.gz";
    url = "https://github.com/unicode-org/icu/archive/refs/tags/release-78.3.tar.gz";
    hash = "sha256-8GvKtyc27p1VaJAzuBmKF4ViNUEozzjtsq/C5n4/2TE=";
  };
  native = [
    {
      id = "bun-icu";
      version = "78.3";
      path = toString icuSource;
      origin = "https://github.com/unicode-org/icu/tree/release-78.3; matches Bun 1.4.2 process.versions.icu";
      license = "Unicode-3.0 AND bundled third-party terms";
      requirements = [ "BUN-7" ];
      notices = [ "LICENSE" ];
    }
    {
      id = "dtach";
      version = pkgs.dtach.version;
      path = toString pkgs.dtach.src;
      origin = "https://github.com/crigler/dtach/tree/b027c27b2439081064d07a86883c8e0b20a183c9";
      license = "GPL-2.0-or-later";
      requirements = [ "DT-1" "DT-2" "DT-3" ];
      notices = [ "COPYING" "dtach.h" ];
    }
    {
      id = "glibc";
      version = pkgs.glibc.version;
      path = toString pkgs.glibc.src;
      origin = "https://sourceware.org/glibc/";
      license = "LGPL-2.1-or-later AND file-specific notices";
      requirements = [ "GLIBC-1" "GLIBC-2" "GLIBC-3" ];
      notices = [ "COPYING.LIB" "LICENSES" ];
    }
    {
      id = "pkl";
      version = pklVersion;
      path = toString pklSource;
      origin = "https://github.com/apple/pkl/tree/${pklVersion}; binary https://github.com/apple/pkl/releases/download/${pklVersion}/pkl-linux-${if system == "x86_64-linux" then "amd64" else "aarch64"}";
      license = "Apache-2.0 AND bundled third-party terms";
      requirements = [ "PKL-1" "PKL-2" "PKL-3" ];
      notices = [ "LICENSE.txt" "NOTICE.txt" "THIRD-PARTY-NOTICES.txt" ];
    }
    {
      id = "zlib";
      version = pkgs.zlib.version;
      path = toString pkgs.zlib.src;
      origin = "https://github.com/madler/zlib/releases/tag/v${pkgs.zlib.version}";
      license = "Zlib";
      requirements = [ ];
      notices = [ "README" ];
    }
    {
      id = "openssl";
      version = pkgs.openssl.version;
      path = toString pkgs.openssl.src;
      origin = "https://github.com/openssl/openssl/releases/tag/openssl-${pkgs.openssl.version}";
      license = "Apache-2.0";
      requirements = [ ];
      notices = [ "LICENSE.txt" ];
    }
    {
      id = "zig-runtime";
      version = pkgs.zig_0_15.version;
      path = toString pkgs.zig_0_15.src;
      origin = "nixpkgs Zig compiler source used for nas helper binaries";
      license = "MIT AND bundled musl terms";
      requirements = [ "MUSL-1" ];
      notices = [ "LICENSE" "lib/libc/musl/COPYRIGHT" ];
    }
    {
      id = "fuse3";
      version = pkgs.fuse3.version;
      path = toString pkgs.fuse3.src;
      origin = "https://github.com/libfuse/libfuse/tree/fuse-${pkgs.fuse3.version}";
      license = "LGPL-2.1-only AND GPL-2.0-only for other files";
      requirements = [ "FUSE-1" "FUSE-2" ];
      notices = [ "LICENSE" "LGPL2.txt" "GPL2.txt" "lib/fuse.c" ];
    }
    {
      id = "graphql-core";
      version = mitmproxyVendor.version;
      path = toString mitmproxyVendor.src;
      origin = "https://pypi.org/project/graphql-core/${mitmproxyVendor.version}/";
      license = "MIT";
      requirements = [ "PKG-1" ];
      notices = [ "LICENSE" ];
    }
  ];
  config = pkgs.writeText "nas-release-source-config.json" (builtins.toJSON {
    inherit system policy native;
    bunVersion = pkgs.bun.version;
    inherit pklVersion;
    runtimeSources = toString runtimeSources;
    npmVerifier = toString ../../scripts/release/bun_npm.ts;
    nodeHeaders = toString nodeHeaders;
    rustSource = toString rustSource;
    pklBinaryPin = pklBinaryPin;
    webkitSource = toString webkitSource;
    webkitRevision = webkitRevision;
    webkitOrigin = "https://github.com/oven-sh/WebKit/tree/${webkitRevision}";
    nasSource = toString self;
    nasVersion = (builtins.fromJSON (builtins.readFile ../../package.json)).version;
    gccSource = toString pkgs.stdenv.cc.cc.src;
    gccVersion = pkgs.stdenv.cc.cc.version;
    rawPayload = toString rawPayload;
    nasAssetsBase = toString nasAssetsBase;
    bundlerRevision = nix-bundle-elf.rev;
    bundlerLicense = "${nix-bundle-elf.outPath}/LICENSE";
    originRoots = [
      { id = "bun-bun"; root = toString nasUnwrapped; }
      { id = "pkl"; root = toString pklNative; }
      { id = "dtach"; root = toString dtachMarked; }
      { id = "glibc"; root = toString pkgs.glibc; }
      { id = "zlib"; root = toString pkgs.zlib; }
      { id = "openssl"; root = toString pkgs.openssl; }
      { id = "gcc-runtime"; root = toString pkgs.stdenv.cc.cc.lib; }
      { id = "fuse3"; root = toString pkgs.fuse3.out; }
      { id = "nas-maskfs"; root = toString maskfs; }
    ];
    originFiles = [
      { id = "nas-hostexec"; name = "hostexec_intercept.so"; path = "${hostexecIntercept}/lib/hostexec_intercept.so"; }
      { id = "nas-hostexec"; name = "nas-hostexec-client"; path = "${hostexecIntercept}/bin/nas-hostexec-client"; }
      { id = "nas-hostexec"; name = "nas-hostexec-gateway"; path = "${hostexecIntercept}/bin/nas-hostexec-gateway"; }
      { id = "nas-maskfs"; name = "nas-maskfs"; path = "${maskfs}/bin/nas-maskfs"; }
      { id = "nas-mask-filter"; name = "nas-mask-filter"; path = "${maskFilter}/bin/nas-mask-filter"; }
    ];
    javascript = {
      cli = "${nasUnwrapped}/share/nas/cli-compliance";
      ui = "${nasUnwrapped}/share/nas/dist/compliance";
    };
    recipes = [
      { id = "nixpkgs-glibc"; path = toString (nixpkgs.outPath + "/pkgs/development/libraries/glibc"); }
      { id = "nixpkgs-dtach"; path = toString (nixpkgs.outPath + "/pkgs/by-name/dt/dtach/package.nix"); }
      { id = "nixpkgs-bun"; path = toString (nixpkgs.outPath + "/pkgs/by-name/bu/bun/package.nix"); }
      { id = "nixpkgs-zlib"; path = toString (nixpkgs.outPath + "/pkgs/development/libraries/zlib"); }
      { id = "nixpkgs-fuse3"; path = toString (nixpkgs.outPath + "/pkgs/os-specific/linux/fuse"); }
      { id = "bun2nix"; path = toString bun2nix.outPath; }
      { id = "nix-bundle-elf"; path = toString nix-bundle-elf.outPath; }
      { id = "mark_elf"; path = toString ../../scripts/release/mark_elf.sh; }
      { id = "runtime-source-inputs"; path = "${runtimeSources}/sources.json"; }
      { id = "bun-npm-source-inputs"; path = "${runtimeSources}/bun-npm-sources.json"; }
      { id = "license-policy"; path = toString ./policy.json; }
    ];
  });
in
pkgs.runCommand "nas-release-inputs-${system}" {
  nativeBuildInputs = [ pkgs.python3 pkgs.gnutar pkgs.gzip pkgs.xz pkgs.bun ];
} ''
  python3 ${../../scripts/release/collect_native.py} ${config} "$out"
''
