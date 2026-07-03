{
  description = "nas — Nix Agent Sandbox";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-bundle-elf = {
      url = "github:Hogeyama/nix-bundle-elf";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, bun2nix, nix-bundle-elf, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        b2n = bun2nix.packages.${system}.default;
        bundle-script = nix-bundle-elf.lib.${system}.bundle-script;

        # nixpkgs.pkl は JVM 版なので Apple の release から直接取得する。
        # （JVM版は起動に800msくらいかかる）
        pklVersion = "0.31.1";
        pklSourceBySystem = {
          "x86_64-linux" = {
            url = "https://github.com/apple/pkl/releases/download/${pklVersion}/pkl-linux-amd64";
            hash = "sha256-YY8TlV11XK+/6MnLodJ2NYSM1J28ar/9OY0nUdsSMb8=";
          };
          "aarch64-linux" = {
            url = "https://github.com/apple/pkl/releases/download/${pklVersion}/pkl-linux-aarch64";
            hash = "sha256-fvEOdD2qkh+5Sue9uexphvNivyUMVYFLnqKusT8tCD4=";
          };
        };
        pklSrc = pkgs.fetchurl pklSourceBySystem.${system};
        # nix-store install 用: glibc/zlib を nix-store から RPATH で解決
        pklNative = pkgs.stdenv.mkDerivation {
          pname = "pkl";
          version = pklVersion;
          src = pklSrc;
          dontUnpack = true;
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.zlib pkgs.stdenv.cc.cc.lib ];
          installPhase = "install -Dm755 $src $out/bin/pkl";
        };
        nasUnwrapped = b2n.mkDerivation {
          pname = "nas";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = self;
          module = "main.ts";
          bunDeps = b2n.fetchBunDeps { bunNix = ./bun.nix; };
          preBuild = ''
            bun run build-ui
          '';
          postInstall = ''
            mkdir -p $out/share/nas
            cp -r src/ui/dist $out/share/nas/dist
          '';
        };

        hostexecIntercept = pkgs.stdenv.mkDerivation {
          pname = "hostexec-intercept";
          version = "0.1.0";
          src = ./src/hostexec/intercept;
          nativeBuildInputs = [ pkgs.zig ];
          dontConfigure = true;
          dontFixup = true;
          doCheck = true;
          buildPhase = ''
            export HOME=$TMPDIR
            zig build \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Doptimize=ReleaseSafe
          '';
          checkPhase = ''
            export HOME=$TMPDIR
            zig build test --global-cache-dir "$TMPDIR/zig-cache"
          '';
          installPhase = ''
            mkdir -p $out/lib
            cp zig-out/lib/libhostexec_intercept.so $out/lib/hostexec_intercept.so
          '';
        };

        maskfs = pkgs.stdenv.mkDerivation {
          pname = "nas-maskfs";
          version = "0.1.0";
          src = ./src/maskfs;
          nativeBuildInputs = [ pkgs.zig pkgs.pkg-config ];
          buildInputs = [ pkgs.fuse3 ];
          dontConfigure = true;
          doCheck = true;
          buildPhase = ''
            export HOME=$TMPDIR
            zig build \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Doptimize=ReleaseSafe
          '';
          checkPhase = ''
            export HOME=$TMPDIR
            zig build test --global-cache-dir "$TMPDIR/zig-cache"
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp zig-out/bin/nas-maskfs $out/bin/
          '';
        };

        # bun compile バイナリは import.meta.url がビルド時パス (/build/source/...)
        # を指すため、アセットを別途配置し NAS_ASSET_DIR で参照する。
        nasAssets = pkgs.runCommand "nas-assets" { } ''
          mkdir -p $out/docker/embed $out/docker/mitmproxy $out/scripts $out/ui $out/hostexec $out/maskfs $out/config/templates

          cp ${self}/src/docker/embed/Dockerfile $out/docker/embed/
          cp ${self}/src/docker/embed/entrypoint.sh $out/docker/embed/
          cp ${self}/src/docker/embed/local-proxy.mjs $out/docker/embed/
          cp ${self}/src/docker/mitmproxy/nas_addon.py $out/docker/mitmproxy/
          cp ${self}/scripts/notify-send-wsl $out/scripts/
          cp -r ${nasUnwrapped}/share/nas/dist $out/ui/
          cp ${hostexecIntercept}/lib/hostexec_intercept.so $out/hostexec/
          cp ${maskfs}/bin/nas-maskfs $out/maskfs/
          cp ${self}/src/config/Schema.pkl $out/config/
          cp ${self}/src/config/templates/config.pkl $out/config/templates/
          cp ${self}/src/config/templates/eval.pkl $out/config/templates/
          cp ${self}/src/config/templates/global.pkl $out/config/templates/
          cp ${self}/src/config/templates/PklProject $out/config/templates/
        '';

        nas = pkgs.runCommand "nas" { } ''
          mkdir -p $out/bin $out/share/nas

          cp ${nasUnwrapped}/bin/nas $out/share/nas/nas
          cp -r ${nasAssets} $out/share/nas/assets

          cat > $out/bin/nas <<'EOF'
          #!/bin/sh
          dir="$(cd "$(dirname "$0")/.." && pwd)"
          export NAS_ASSET_DIR="$dir/share/nas/assets"
          # Expose a stable absolute path to this wrapper so the UI
          # daemon can spawn new sessions after its originating session
          # cleaned up /tmp (where the inner binary would otherwise go).
          export NAS_BIN_PATH="''${NAS_BIN_PATH:-$dir/share/nas/nas}"
          # ネイティブ pkl を先頭に置く (loadPklConfig が PATH 経由で呼ぶ)
          export PATH="${pklNative}/bin:''${PATH}"
          exec "$dir/share/nas/nas" "$@"
          EOF
          chmod +x $out/bin/nas
        '';

        maskfsPackage = pkgs.symlinkJoin {
          name = "maskfs";
          paths = [ maskfs ];
          postBuild = ''
            cp ${./src/maskfs/maskfs} $out/bin/maskfs
            chmod +x $out/bin/maskfs
          '';
        };

        maskfsBundled = bundle-script {
          name = "maskfs";
          script = "${maskfsPackage}/bin/maskfs";
          type = "preload";
          binaries = [
            { name = "nas-maskfs"; target = "${maskfs}/bin/nas-maskfs"; }
            # fusermount3 は同梱しない: バンドル展開先のコピーには setuid が付かず
            # mount(2) が必ず EPERM になる。ホストの setuid 版 (fuse3 パッケージ) に
            # PATH フォールバックで到達させる。
          ];
        };

        # nas 本体と pkl を同じバンドルへ。bundle-script が両方の ELF 依存を
        # 一括解決して同梱するため、ユーザ系の glibc / libz には依存しない。
        nasBundledEntry = pkgs.writeScript "nas-bundled-entry" ''
          #!/bin/sh
          exec nas "$@"
        '';
        nasBundled = bundle-script {
          name = "nas";
          script = nasBundledEntry;
          type = "preload";
          binaries = [
            { name = "nas"; target = "${nasUnwrapped}/bin/nas"; }
            { name = "pkl"; target = "${pklNative}/bin/pkl"; }
          ];
          extraFiles = {
            "share/nas/assets" = nasAssets;
          };
          resolveWith = [
            "${pkgs.glibc}/lib/libpthread.so.0"
            "${pkgs.glibc}/lib/libdl.so.2"
            "${pkgs.glibc}/lib/librt.so.1"
            "${pkgs.glibc}/lib/libm.so.6"
            "${pkgs.glibc}/lib/libc.so.6"
            "${pkgs.gcc.cc.lib}/lib/libgcc_s.so.1"
          ];
          env = [
            { key = "NAS_ASSET_DIR"; action = "replace"; value = "%ROOT/share/nas/assets"; }
            # nas ui の New Session で起動するバイナリもバンドル版を指すようにする。
            # そうしないと /tmp に展開された削除済みのELFを指してしまう。
            { key = "NAS_BIN_PATH"; action = "replace"; value = "%ORIG"; }
          ];
        };
      in
      {
        packages = {
          default = nas;
          bundled = nasBundled;
          maskfs = maskfsPackage;
          maskfs-bundled = maskfsBundled;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            b2n
            pkgs.nodejs
            pkgs.pnpm
            pkgs.chromium
            pkgs.dtach
            pkgs.zig
            pkgs.fuse3
            pkgs.pkg-config
            pklNative
          ];
          shellHook = ''
            if [ ! -f .playwright/cli.config.json ]; then
              mkdir -p .playwright
              cat > .playwright/cli.config.json <<EOF
            {
              "browser": {
                "browserName": "chromium",
                "launchOptions": {
                  "executablePath": "${pkgs.chromium}/bin/chromium",
                  "args": ["--force-device-scale-factor=2"],
                  "chromiumSandbox": false
                }
              }
            }
            EOF
            fi
          '';
        };
      });
}
