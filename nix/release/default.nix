# Release inputs (notices, sources, recipes) for products that ship the Bun
# runtime. The Bun, WebKit, and runtime source pins are shared: nas and
# strait run the same pkgs.bun, so they cite the same materials for it.
{ pkgs
, system
, self
, nixpkgs
, bun2nix
, nix-bundle-elf
, pklVersion
}:

let
  nodeHeadersUrl = "https://nodejs.org/dist/v26.3.0/node-v26.3.0-headers.tar.gz";
  nodeHeaders = pkgs.fetchurl {
    url = nodeHeadersUrl;
    hash = "sha256-/KETxdWt2L+xqjESmiSsuNSappqzwiosxWmuyIlgUm0=";
  };
  rustSourceUrl = "https://static.rust-lang.org/dist/2026-07-20/rust-src-nightly.tar.xz";
  rustSource = pkgs.fetchurl {
    url = rustSourceUrl;
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

  # Only the notices of the JSC runtime Bun links are read from WebKit; its
  # source is referenced upstream. A sparse, blob-filtered fetch of the three
  # compiled trees avoids downloading the 6.5 GB fork.
  webkitRevision = "2e2aa2290fac856d6f451ceacb58f7f5b44dd057";
  webkitSource = pkgs.fetchgit {
    url = "https://github.com/oven-sh/WebKit.git";
    rev = webkitRevision;
    sparseCheckout = [ "Source/JavaScriptCore" "Source/WTF" "Source/bmalloc" ];
    hash = "sha256-MkyE4dJ/Wyjxvzi2ZXWkbHpSxMJa2YH4NCgUx7vANPc=";
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
  nativeEntry = {
    "bun-icu" = {
      id = "bun-icu";
      version = "78.3";
      path = toString icuSource;
      origin = "https://github.com/unicode-org/icu/tree/release-78.3; matches Bun 1.4.2 process.versions.icu";
      license = "Unicode-3.0 AND bundled third-party terms";
      requirements = [ "BUN-7" ];
      notices = [ "LICENSE" ];
      # Bun's Linux relink route uses the system ICU (libicu-dev); see BUN-7.
      source = false;
    };
    dtach = {
      id = "dtach";
      version = pkgs.dtach.version;
      path = toString pkgs.dtach.src;
      origin = "https://github.com/crigler/dtach/tree/b027c27b2439081064d07a86883c8e0b20a183c9";
      license = "GPL-2.0-or-later";
      requirements = [ "DT-1" "DT-2" "DT-3" ];
      notices = [ "COPYING" "dtach.h" ];
    };
    glibc = {
      id = "glibc";
      version = pkgs.glibc.version;
      path = toString pkgs.glibc.src;
      origin = "https://sourceware.org/glibc/";
      license = "LGPL-2.1-or-later AND file-specific notices";
      requirements = [ "GLIBC-1" "GLIBC-2" "GLIBC-3" ];
      notices = [ "COPYING.LIB" "LICENSES" ];
    };
    pkl = {
      id = "pkl";
      version = pklVersion;
      path = toString pklSource;
      origin = "https://github.com/apple/pkl/tree/${pklVersion}; binary https://github.com/apple/pkl/releases/download/${pklVersion}/pkl-linux-${if system == "x86_64-linux" then "amd64" else "aarch64"}";
      license = "Apache-2.0 AND bundled third-party terms";
      requirements = [ "PKL-1" "PKL-2" "PKL-3" ];
      notices = [ "LICENSE.txt" "NOTICE.txt" "THIRD-PARTY-NOTICES.txt" ];
      source = false;
    };
    zlib = {
      id = "zlib";
      version = pkgs.zlib.version;
      path = toString pkgs.zlib.src;
      origin = "https://github.com/madler/zlib/releases/tag/v${pkgs.zlib.version}";
      license = "Zlib";
      requirements = [ ];
      notices = [ "README" ];
      source = false;
      payloadOnly = true;
    };
    openssl = {
      id = "openssl";
      version = pkgs.openssl.version;
      path = toString pkgs.openssl.src;
      origin = "https://github.com/openssl/openssl/releases/tag/openssl-${pkgs.openssl.version}";
      license = "Apache-2.0";
      requirements = [ ];
      notices = [ "LICENSE.txt" ];
      source = false;
      payloadOnly = true;
    };
    "zig-runtime" = {
      id = "zig-runtime";
      version = pkgs.zig_0_15.version;
      path = toString pkgs.zig_0_15.src;
      origin = "nixpkgs Zig compiler source used for nas helper binaries";
      license = "MIT AND bundled musl terms";
      requirements = [ "MUSL-1" ];
      notices = [ "LICENSE" "lib/libc/musl/COPYRIGHT" ];
      source = false;
    };
    fuse3 = {
      id = "fuse3";
      version = pkgs.fuse3.version;
      path = toString pkgs.fuse3.src;
      origin = "https://github.com/libfuse/libfuse/tree/fuse-${pkgs.fuse3.version}";
      license = "LGPL-2.1-only AND GPL-2.0-only for other files";
      requirements = [ "FUSE-1" "FUSE-2" ];
      notices = [ "LICENSE" "LGPL2.txt" "GPL2.txt" "lib/fuse.c" ];
    };
  };
  # GPL-2.0 text for Bun's libtcc1.c; any verbatim copy serves.
  gplv2Text = "${pkgs.dtach.src}/COPYING";
  bundlerLicense = "${nix-bundle-elf.outPath}/LICENSE";
  # Settings every Bun product shares; each product adds its own.
  common = {
    inherit system policy;
    bunVersion = pkgs.bun.version;
    runtimeSources = toString runtimeSources;
    npmVerifier = toString ../../scripts/release/bun_npm.ts;
    sourceNoticeCollector = toString ../../scripts/release/source_notices.ts;
    nodeHeaders = toString nodeHeaders;
    rustSource = toString rustSource;
    webkitSource = toString webkitSource;
    webkitRevision = webkitRevision;
    webkitOrigin = "https://github.com/oven-sh/WebKit/tree/${webkitRevision}";
    gccSource = toString pkgs.stdenv.cc.cc.src;
    gccVersion = pkgs.stdenv.cc.cc.version;
    bundlerRevision = nix-bundle-elf.rev;
    inherit bundlerLicense gplv2Text;
  };
  # Bun and Pkl sources are not copied; the materials record where the
  # pinned upstream bytes live.
  commonUpstream = {
    nodeHeaders = { url = nodeHeadersUrl; inherit (nodeHeaders) outputHash; };
    rustSource = { url = rustSourceUrl; inherit (rustSource) outputHash; };
    webkit = { repo = "https://github.com/oven-sh/WebKit"; commit = webkitRevision; };
  };
  mkInputs = name: settings:
    let
      config = pkgs.writeText "${name}-source-config.json" (builtins.toJSON (common // settings));
    in
    pkgs.runCommand "${name}-release-inputs-${system}" {
      nativeBuildInputs = [ pkgs.python3 pkgs.gnutar pkgs.gzip pkgs.xz pkgs.bun ];
    } ''
      python3 ${../../scripts/release/collect_native.py} ${config} "$out"
    '';
  recipe = id: path: { inherit id; path = toString path; };
  bunRecipes = [
    (recipe "runtime-source-inputs" "${runtimeSources}/sources.json")
    (recipe "bun-npm-source-inputs" "${runtimeSources}/bun-npm-sources.json")
    (recipe "license-policy" ./policy.json)
  ];
in
{
  nas =
    { nasUnwrapped
    , rawPayload
    , pklBinaryPin
    , pklNative
    , dtachMarked
    , hostexecIntercept
    , maskfs
    , maskFilter
    , sumi
    , mitmproxyVendor
    , nasAssetsBase
    }:
    mkInputs "nas" {
      native = map (id: nativeEntry.${id}) [
        "bun-icu" "dtach" "glibc" "pkl" "zlib" "openssl" "zig-runtime" "fuse3"
      ] ++ [
        {
          id = "graphql-core";
          version = mitmproxyVendor.version;
          path = toString mitmproxyVendor.src;
          origin = "https://pypi.org/project/graphql-core/${mitmproxyVendor.version}/";
          license = "MIT";
          requirements = [ "PKG-1" ];
          notices = [ "LICENSE" ];
          source = false;
        }
      ];
      inherit pklVersion pklBinaryPin;
      upstream = commonUpstream // {
        pkl = { repo = "https://github.com/apple/pkl"; tag = pklVersion; };
      };
      product = {
        id = "nas";
        version = (builtins.fromJSON (builtins.readFile ../../package.json)).version;
        source = toString self;
        subcomponents = [ "nas-hostexec" "nas-maskfs" "nas-mask-filter" "sumi" ];
      };
      rawPayload = toString rawPayload;
      nasAssetsBase = toString nasAssetsBase;
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
        { id = "sumi"; name = "sumi"; path = "${sumi}/bin/sumi"; }
      ];
      javascript = {
        cli = "${nasUnwrapped}/share/nas/cli-compliance";
        ui = "${nasUnwrapped}/share/nas/dist/compliance";
      };
      recipes = [
        (recipe "nixpkgs-glibc" (nixpkgs.outPath + "/pkgs/development/libraries/glibc"))
        (recipe "nixpkgs-dtach" (nixpkgs.outPath + "/pkgs/by-name/dt/dtach/package.nix"))
        (recipe "nixpkgs-bun" (nixpkgs.outPath + "/pkgs/by-name/bu/bun/package.nix"))
        (recipe "nixpkgs-zlib" (nixpkgs.outPath + "/pkgs/development/libraries/zlib"))
        (recipe "nixpkgs-fuse3" (nixpkgs.outPath + "/pkgs/os-specific/linux/fuse"))
        (recipe "bun2nix" bun2nix.outPath)
        (recipe "nix-bundle-elf" nix-bundle-elf.outPath)
        (recipe "mark_elf" ../../scripts/release/mark_elf.sh)
      ] ++ bunRecipes;
    };

  # strait runs pkgs.bun itself (not a --compile executable), next to its
  # unbundled npm packages (nodeModules, as the bundle ships them) and srt's
  # rebuilt apply-seccomp.
  strait =
    { nodeModules
    , straitVersion
    , rawPayload
    , srtSource
    , srtVersion
    , srtApplySeccomp
    }:
    mkInputs "strait" {
      native = map (id: nativeEntry.${id}) [ "bun-icu" "glibc" "zig-runtime" ] ++ [
        {
          id = "srt-apply-seccomp";
          version = srtVersion;
          path = toString srtSource;
          origin = "https://github.com/anthropics/sandbox-runtime/tree/v${srtVersion}/vendor/seccomp-src; built from source with Zig's musl";
          license = "Apache-2.0";
          requirements = [ "SRT-1" ];
          notices = [ "LICENSE" ];
          source = false;
        }
      ];
      upstream = commonUpstream // {
        extra.sandboxRuntime = {
          repo = "https://github.com/anthropics/sandbox-runtime";
          tag = "v${srtVersion}";
          inherit (srtSource) outputHash;
        };
      };
      product = {
        id = "strait";
        version = straitVersion;
        source = toString self;
        subcomponents = [ ];
      };
      rawPayload = toString rawPayload;
      originRoots = [
        { id = "bun-bun"; root = toString pkgs.bun; }
        { id = "glibc"; root = toString pkgs.glibc; }
        { id = "gcc-runtime"; root = toString pkgs.stdenv.cc.cc.lib; }
      ];
      originFiles = [
        { id = "srt-apply-seccomp"; name = "apply-seccomp"; path = "${srtApplySeccomp}/bin/apply-seccomp"; under = toString nodeModules; }
      ];
      javascript = { };
      npmPackages = {
        id = "strait";
        root = toString nodeModules;
        reviewed = builtins.fromJSON (builtins.readFile ./strait-packages.json);
      };
      recipes = [
        (recipe "nixpkgs-glibc" (nixpkgs.outPath + "/pkgs/development/libraries/glibc"))
        (recipe "nixpkgs-bun" (nixpkgs.outPath + "/pkgs/by-name/bu/bun/package.nix"))
        (recipe "bun2nix" bun2nix.outPath)
        (recipe "nix-bundle-elf" nix-bundle-elf.outPath)
        (recipe "strait-packages-policy" ./strait-packages.json)
      ] ++ bunRecipes;
    };
}
