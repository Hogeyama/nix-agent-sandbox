{
  description = "nas — Nix Agent Sandbox";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # nas は Linux 専用。依存 flake でも廃止済みの Intel Darwin を評価しない。
    systems.url = "github:nix-systems/default-linux";
    flake-utils.url = "github:numtide/flake-utils";
    flake-utils.inputs.systems.follows = "systems";
    nix-bundle-elf = {
      url = "github:Hogeyama/nix-bundle-elf";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
  };

  outputs = { self, nixpkgs, flake-utils, bun2nix, nix-bundle-elf, ... }:
    let
      # diffity (nilbuild/diffity) は npm 配布のみで flake を持たない。
      # nas の成果物ではなく「上流の再パッケージ」なので packages には出さず、
      # overlay として公開する。利用側は自分の nixpkgs に載せて pkgs.diffity と
      # して使う。
      overlays.diffity = final: _prev: {
        diffity = final.callPackage ./nix/diffity { };
      };
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system}.extend overlays.diffity;
        b2n = bun2nix.packages.${system}.default;
        bunDeps = b2n.fetchBunDeps { bunNix = ./bun.nix; };
        bundle-script = nix-bundle-elf.lib.${system}.bundle-script;
        modifiedDate = let d = self.lastModifiedDate or "20260923000000"; in
          "${builtins.substring 0 4 d}-${builtins.substring 4 2 d}-${builtins.substring 6 2 d}";

        # src/hostexec/intercept, contrib/maskfs, src/mask-filter は Zig 0.15 の
        # API を前提に書かれている。pkgs.zig は nixpkgs 側の alias で、追従する
        # と breaking release でビルドが黙って壊れるため明示的に固定する。
        zig = pkgs.zig_0_15;

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
          nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.binutils ];
          buildInputs = [ pkgs.zlib pkgs.stdenv.cc.cc.lib ];
          installPhase = ''
            mkdir -p $out/bin
            bash ${./scripts/release/mark_elf.sh} pkl "$src" "$out/bin/pkl" ${modifiedDate}
          '';
        };
        dtachMarked = pkgs.dtach.overrideAttrs (old: {
          nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.binutils ];
          postInstall = (old.postInstall or "") + ''
            bash ${./scripts/release/mark_elf.sh} dtach "$out/bin/dtach" "$out/bin/dtach.nas-marked" ${modifiedDate}
            mv "$out/bin/dtach.nas-marked" "$out/bin/dtach"
          '';
        });
        nasUnwrapped = b2n.mkDerivation {
          pname = "nas";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = self;
          inherit bunDeps;
          # Bun's standalone executable keeps its embedded entrypoint in an
          # appended payload. strip removes that payload and leaves bare Bun.
          dontStrip = true;
          buildPhase = ''
            runHook preBuild
            bun run build-ui
            bun scripts/compile.ts --outfile nas --materials-dir release-js
            runHook postBuild
          '';
          postInstall = ''
            mkdir -p $out/share/nas
            cp -r src/ui/dist $out/share/nas/dist
            cp -r release-js $out/share/nas/cli-compliance
          '';
          postFixup = ''
            version_output="$($out/bin/nas --version)"
            case "$version_output" in
              "nas "*) ;;
              *) echo "standalone nas entrypoint lost during fixup: $version_output" >&2; exit 1 ;;
            esac
          '';
        };

        hostexecIntercept = pkgs.stdenv.mkDerivation {
          pname = "hostexec-intercept";
          version = "0.1.0";
          src = ./src/hostexec/intercept;
          nativeBuildInputs = [ zig pkgs.removeReferencesTo ];
          dontConfigure = true;
          dontFixup = true;
          doCheck = true;
          buildPhase = ''
            export HOME=$TMPDIR
            zig build \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Doptimize=ReleaseSafe
          '';
          checkPhase = let
            testTools = pkgs.symlinkJoin {
              name = "hostexec-test-tools";
              paths = [ pkgs.bash pkgs.coreutils ];
            };
          in ''
            export HOME=$TMPDIR
            zig build test \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Dtest-bin-dir=${testTools}/bin
          '';
          installPhase = ''
            mkdir -p $out/lib $out/bin
            cp zig-out/lib/libhostexec_intercept.so $out/lib/hostexec_intercept.so
            cp zig-out/bin/nas-hostexec-client $out/bin/
            cp zig-out/bin/nas-hostexec-gateway $out/bin/
            # dontFixup で strip しないため、debug info に zig 標準ライブラリの
            # store path が残る。放置すると zig + llvm (~900MiB) が nas の
            # runtime closure に入るので参照だけ消す。
            remove-references-to -t ${zig} $out/lib/* $out/bin/*
          '';
        };

        # maskfs は nas とは別に maskfs-v* タグでリリースする。バージョンの
        # 出どころは contrib/maskfs/VERSION だけで、release-maskfs.yml が
        # タグとの一致を検査する。
        maskfsVersion = pkgs.lib.removeSuffix "\n" (builtins.readFile ./contrib/maskfs/VERSION);

        maskfs = pkgs.stdenv.mkDerivation {
          pname = "nas-maskfs";
          version = maskfsVersion;
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./contrib/maskfs
              ./lib/masking
            ];
          };
          sourceRoot = "source/contrib/maskfs";
          nativeBuildInputs = [ zig pkgs.pkg-config ];
          buildInputs = [ pkgs.fuse3 ];
          dontConfigure = true;
          doCheck = true;
          buildPhase = ''
            export HOME=$TMPDIR
            zig build \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Doptimize=ReleaseSafe \
              -Dversion=${maskfsVersion}
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

        maskFilter = pkgs.stdenv.mkDerivation {
          pname = "nas-mask-filter";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./src/mask-filter
              ./lib/process-supervisor
              ./lib/masking
            ];
          };
          sourceRoot = "source/src/mask-filter";
          nativeBuildInputs = [ zig pkgs.removeReferencesTo ];
          dontConfigure = true;
          dontFixup = true;
          doCheck = true;
          buildPhase = ''
            export HOME=$TMPDIR
            zig build \
              --global-cache-dir "$TMPDIR/zig-cache" \
              -Dtarget=${pkgs.stdenv.hostPlatform.parsed.cpu.name}-linux-musl \
              -Doptimize=ReleaseSafe
          '';
          checkPhase = ''
            export HOME=$TMPDIR
            zig build test --global-cache-dir "$TMPDIR/zig-cache"
            (cd ../../lib/masking && zig build test --cache-dir "$TMPDIR/masking-cache" --global-cache-dir "$TMPDIR/zig-cache")
            (cd ../../lib/process-supervisor && zig build test --cache-dir "$TMPDIR/process-supervisor-cache" --global-cache-dir "$TMPDIR/zig-cache")
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp zig-out/bin/nas-mask-filter $out/bin/
            # hostexecIntercept と同じ理由で zig への参照を消す。
            remove-references-to -t ${zig} $out/bin/*
          '';
        };

        # sumi は nas とは別に sumi-v* タグでリリースする。バージョンの出どころは
        # contrib/sumi/VERSION だけで、release-sumi.yml がタグとの一致を検査する。
        sumiVersion = pkgs.lib.removeSuffix "\n" (builtins.readFile ./contrib/sumi/VERSION);

        # 単一の静的バイナリとして配る。Zig が musl を同梱しているので、
        # nix-bundle-elf で glibc を束ねる必要が無い。テストは実行ファイルの
        # ターゲットとは別にホスト向けにビルドされる (build.zig を参照)。
        sumi = pkgs.stdenv.mkDerivation {
          pname = "sumi";
          version = sumiVersion;
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./contrib/sumi
              ./lib/process-supervisor
              ./lib/masking
            ];
          };
          sourceRoot = "source/contrib/sumi";
          nativeBuildInputs = [ zig ];
          dontConfigure = true;
          dontFixup = true;
          doCheck = true;
          buildPhase = ''
            zig build \
              --global-cache-dir "$TMPDIR/sumi-zig-cache" \
              -Dtarget=${pkgs.stdenv.hostPlatform.parsed.cpu.name}-linux-musl \
              -Doptimize=ReleaseSafe \
              -Dstrip=true \
              -Dversion=${sumiVersion}
          '';
          checkPhase = ''
            zig build test \
              --global-cache-dir "$TMPDIR/sumi-zig-cache"
            (cd ../../lib/masking && zig build test --cache-dir "$TMPDIR/masking-cache" --global-cache-dir "$TMPDIR/sumi-zig-cache")
            (cd ../../lib/process-supervisor && zig build test --cache-dir "$TMPDIR/process-supervisor-cache" --global-cache-dir "$TMPDIR/sumi-zig-cache")
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp zig-out/bin/sumi $out/bin/
          '';
        };

        # vendor-requirements.txt が vendored 依存の唯一の真実の源。
        # dev 経路は `bun run vendor` (uv pip install --target) が
        # src/docker/mitmproxy/vendor/ を生成するが、このディレクトリは
        # gitignore 済みで flake の src には現れない。バンドル側は同じ pin
        # を読んで sdist を取得し、addon が sys.path に足すのと同じ
        # layout (vendor/graphql/) を組み立てる。sdist のファイル名は
        # 正規化済みの `graphql_core` (アンダースコア) である。
        graphqlCorePin = let
          # vendor-requirements.txt はヘッダコメントを持つ (ファイル先頭
          # 参照)。最初の非コメント・非空行の先頭トークンが pin 本体で、
          # 行内コメントや前後の空白はここで落とす。
          pinLines = builtins.filter
            (line: builtins.match "^[[:space:]]*[^#[:space:]].*" line != null)
            (pkgs.lib.splitString "\n" (
              builtins.readFile ./src/docker/mitmproxy/vendor-requirements.txt
            ));
          line = builtins.head (
            builtins.filter (token: builtins.isString token && token != "") (
              builtins.split "[[:space:]]+" (builtins.elemAt pinLines 0)
            )
          );
          parts = pkgs.lib.splitString "==" line;
          pname = builtins.elemAt parts 0;
        in {
          inherit pname;
          version = builtins.elemAt parts 1;
          # PyPI の sdist ファイル名は正規化済み (ハイフンはアンダースコア)。
          sdistName = builtins.replaceStrings [ "-" ] [ "_" ] pname;
        };
        mitmproxyVendor = pkgs.stdenv.mkDerivation {
          pname = "nas-mitmproxy-vendor";
          version = graphqlCorePin.version;
          src = pkgs.fetchurl {
            url = "https://files.pythonhosted.org/packages/source/g/${graphqlCorePin.pname}/${graphqlCorePin.sdistName}-${graphqlCorePin.version}.tar.gz";
            hash = "sha256-5+FW0QvrEnyrXIn/DacUFvxz0nxISkdX07LTVjN3SAI=";
          };
          installPhase = ''
            mkdir -p $out
            cp -r src/graphql $out/graphql
            cp LICENSE $out/LICENSE-graphql-core
          '';
        };

        # contrib/vscode-nas-approval はホスト側 VS Code に入れる拡張。
        # vsce package はファイルを zip するだけで完結するが、npm 不在の
        # ビルドサンドボックスで依存解決を試みないよう --no-dependencies が必須。
        # package.json に repository が無いと対話プロンプトで止まるため
        # フラグで黙らせる。LICENSE はリポジトリのものを同梱済み。
        vscodeApprovalVersion =
          (builtins.fromJSON (builtins.readFile ./contrib/vscode-nas-approval/package.json)).version;
        vscodeNasApproval = pkgs.stdenv.mkDerivation {
          pname = "nas-approval";
          version = vscodeApprovalVersion;
          src = ./contrib/vscode-nas-approval;
          nativeBuildInputs = [ pkgs.vsce ];
          dontConfigure = true;
          buildPhase = ''
            export HOME=$TMPDIR
            vsce package --no-dependencies --allow-missing-repository \
              --out nas-approval-${vscodeApprovalVersion}.vsix
          '';
          installPhase = ''
            mkdir -p $out
            cp nas-approval-*.vsix $out/
          '';
        };

        # bun compile バイナリは import.meta.url がビルド時パス (/build/source/...)
        # を指すため、アセットを別途配置し NAS_ASSET_DIR で参照する。
        nasAssetsBase = pkgs.runCommand "nas-assets-base" { } ''
          mkdir -p $out/docker/embed $out/docker/mitmproxy $out/scripts $out/ui $out/hostexec $out/maskfs $out/mask-filter $out/config/templates

          cp -r ${self}/src/docker/embed/. $out/docker/embed/
          cp ${self}/src/docker/mitmproxy/nas_addon.py $out/docker/mitmproxy/
          cp -r ${mitmproxyVendor} $out/docker/mitmproxy/vendor
          cp ${self}/scripts/notify-send-wsl $out/scripts/
          mkdir -p $out/ui/dist
          cp ${nasUnwrapped}/share/nas/dist/index.html $out/ui/dist/
          cp -r ${nasUnwrapped}/share/nas/dist/assets $out/ui/dist/
          cp ${hostexecIntercept}/lib/hostexec_intercept.so $out/hostexec/
          cp ${hostexecIntercept}/bin/nas-hostexec-client $out/hostexec/
          cp ${hostexecIntercept}/bin/nas-hostexec-gateway $out/hostexec/
          cp ${maskfs}/bin/nas-maskfs $out/maskfs/
          cp ${maskFilter}/bin/nas-mask-filter $out/mask-filter/
          cp ${self}/src/config/Schema.pkl $out/config/
          cp ${self}/src/config/templates/config.pkl $out/config/templates/
          cp ${self}/src/config/templates/eval.pkl $out/config/templates/
          cp ${self}/src/config/templates/global.pkl $out/config/templates/
          cp ${self}/src/config/templates/PklProject $out/config/templates/
        '';
        nasAssetsBundleBase = pkgs.runCommand "nas-assets-bundle-base" { } ''
          mkdir -p $out
          cp -r ${nasAssetsBase}/. $out/
          chmod u+w $out/maskfs
          rm $out/maskfs/nas-maskfs
          cat > $out/maskfs/nas-maskfs <<'EOF'
          #!/bin/sh
          root="$(cd "$(dirname "$0")/../../../.." && pwd)"
          exec "$root/libexec/nas-maskfs" "$@"
          EOF
          chmod +x $out/maskfs/nas-maskfs
        '';
        releaseInputs = import ./nix/release {
          inherit pkgs system self nixpkgs bun2nix nix-bundle-elf nasUnwrapped rawPayload pklVersion
            pklNative dtachMarked hostexecIntercept maskfs maskFilter mitmproxyVendor;
          pklBinaryPin = pklSourceBySystem.${system};
          nasAssetsBase = nasAssetsBundleBase;
        };
        nasAssetsBundle = pkgs.runCommand "nas-assets-bundle" { } ''
          mkdir -p $out
          cp -r ${nasAssetsBundleBase}/. $out/
          cp -r ${releaseInputs}/licenses $out/licenses
        '';

        nas = pkgs.runCommand "nas" { } ''
          mkdir -p $out/bin $out/share/nas

          cp ${nasUnwrapped}/bin/nas $out/share/nas/nas
          cp -r ${nasAssetsBase} $out/share/nas/assets

          cat > $out/bin/nas <<'EOF'
          #!/bin/sh
          dir="$(cd "$(dirname "$0")/.." && pwd)"
          export NAS_ASSET_DIR="$dir/share/nas/assets"
          # Expose a stable absolute path to this wrapper so the UI
          # daemon can spawn new sessions after its originating session
          # cleaned up /tmp (where the inner binary would otherwise go).
          # It names the wrapper, not the binary beside it: a caller that
          # inherits nothing — a Dev Container's initializeCommand, run by
          # the IDE — needs the entry point that sets the variables below,
          # and re-entering through it is idempotent for the ones that do
          # inherit them.
          export NAS_BIN_PATH="''${NAS_BIN_PATH:-$dir/bin/nas}"
          export NAS_GIT_REVISION="${self.shortRev or self.dirtyShortRev or "unknown"}"
          # Nix package も bundle と同じ dtach/Pkl を使う。
          export PATH="${dtachMarked}/bin:${pklNative}/bin:''${PATH}"
          exec "$dir/share/nas/nas" "$@"
          EOF
          chmod +x $out/bin/nas
        '';

        maskfsPackage = pkgs.symlinkJoin {
          name = "maskfs";
          paths = [ maskfs ];
          postBuild = ''
            cp ${./contrib/maskfs/maskfs} $out/bin/maskfs
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
        mkNasBundle = assets: runtime: bundle-script {
          name = "nas";
          script = nasBundledEntry;
          type = "preload";
          binaries = [
            { name = "nas"; target = runtime; }
            { name = "pkl"; target = "${pklNative}/bin/pkl"; }
            { name = "dtach"; target = "${dtachMarked}/bin/dtach"; }
            { name = "nas-maskfs"; target = "${maskfs}/bin/nas-maskfs"; }
          ];
          extraFiles = {
            "share/nas/assets" = assets;
          };
          resolveWith = [
            "${pkgs.glibc}/lib/libpthread.so.0"
            "${pkgs.glibc}/lib/libdl.so.2"
            "${pkgs.glibc}/lib/librt.so.1"
            "${pkgs.glibc}/lib/libm.so.6"
            "${pkgs.glibc}/lib/libc.so.6"
            "${pkgs.gcc.cc.lib}/lib/libgcc_s.so.1"
            "${pkgs.fuse3.out}/lib/libfuse3.so.4"
          ];
          env = [
            { key = "NAS_ASSET_DIR"; action = "replace"; value = "%ROOT/share/nas/assets"; }
            # nas ui の New Session で起動するバイナリもバンドル版を指すようにする。
            # そうしないと /tmp に展開された削除済みのELFを指してしまう。
            { key = "NAS_BIN_PATH"; action = "replace"; value = "%ORIG"; }
          ];
        };
        nasBundledRaw = mkNasBundle nasAssetsBundleBase "${nasUnwrapped}/bin/nas";
        rawPayload = pkgs.runCommand "nas-raw-payload-${system}" { } ''
          ${nasBundledRaw} --extract "$out"
        '';
        nasBundled = mkNasBundle nasAssetsBundle "${nasUnwrapped}/bin/nas";
        nasBundledWithRuntime =
          let
            runtime = builtins.getEnv "NAS_REBUILT_BINARY";
          in
          if runtime == "" || builtins.substring 0 1 runtime != "/" then
            throw "set NAS_REBUILT_BINARY to an absolute executable path and build with --impure"
          else
            mkNasBundle nasAssetsBundle (builtins.path { path = runtime; name = "nas-rebuilt-runtime"; });
      in
      {
        packages = {
          default = nas;
          bundled = nasBundled;
          release-inputs = releaseInputs;
          maskfs = maskfsPackage;
          maskfs-bundled = maskfsBundled;
          mask-filter = maskFilter;
          sumi = sumi;
          vscode-nas-approval = vscodeNasApproval;
        } // pkgs.lib.optionalAttrs (builtins.getEnv "NAS_REBUILT_BINARY" != "") {
          bundled-with-runtime = nasBundledWithRuntime;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            b2n
            pkgs.direnv
            pkgs.jq
            pkgs.nodejs
            pkgs.pnpm
            pkgs.chromium
            pkgs.dtach
            # claude-code (unfree) only seeds CLAUDE_CODE_EXECUTABLE's default;
            # nas always sets it to the mounted host binary.
            (pkgs.claude-agent-acp.override {
              claude-code = pkgs.writeShellScriptBin "claude" ''
                echo "CLAUDE_CODE_EXECUTABLE is not set" >&2
                exit 1
              '';
            })
            # display.sandbox: xpra が生成した cookie の読み出しに使う。
            # xpra 本体は opt-in なのでホスト提供に任せるが、xauth は
            # closure が小さく、無いと DisplayStage が起動時に落ちる。
            pkgs.xauth
            zig
            pkgs.fuse3
            pkgs.pkg-config
            # テストヘルパの実行に使う。nas 本体の実行時依存ではないが、
            # TypeScript では書けないクライアント (mask-filter の serve モードに
            # 対する「書くだけで読まない」クライアント等) や
            # nas_addon.py のユニットテストがこれに依存する。宣言しておかないと
            # ホストの profile 次第でテストが黙って skip される。
            pkgs.python3
            # `bun run vendor` が呼ぶ。src/docker/mitmproxy/vendor/ を
            # vendor-requirements.txt から生成するのに必要。
            pkgs.uv
            pklNative
            # 静的に検出できる規約は prompt ではなく ast-grep ルールに落とす。
            pkgs.ast-grep
            # skills/ の diffity-* が呼ぶ差分ビューア。npm -g ではなく
            # flake 側で固定して、シェルに入れば必ず同じ版が使えるようにする。
            pkgs.diffity
          ];
          shellHook = ''
            # ast-grep は Zig を組み込みでサポートしないため、tree-sitter の
            # grammar を customLanguages として登録する。sgconfig.yml は store
            # path を含められないので、安定した相対パスへの symlink をここで張る。
            mkdir -p .ast-grep
            ln -sfn ${pkgs.tree-sitter-grammars.tree-sitter-zig}/parser \
              .ast-grep/tree-sitter-zig.so

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
      })
    // { inherit overlays; };
}
