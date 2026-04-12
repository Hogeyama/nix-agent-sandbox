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
        single-exe = nix-bundle-elf.lib.${system}.single-exe;
        nasBin = b2n.mkDerivation {
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

        # bun compile バイナリは import.meta.url がビルド時パス (/build/source/...)
        # を指すため、アセットを別途配置し NAS_ASSET_DIR で参照する。
        nasAssets = pkgs.runCommand "nas-assets" { } ''
          mkdir -p $out/docker/embed $out/docker/envoy $out/scripts $out/ui

          cp ${self}/src/docker/embed/Dockerfile $out/docker/embed/
          cp ${self}/src/docker/embed/entrypoint.sh $out/docker/embed/
          cp ${self}/src/docker/embed/osc52-clip.sh $out/docker/embed/
          cp ${self}/src/docker/embed/local-proxy.mjs $out/docker/embed/
          cp ${self}/src/docker/envoy/envoy.template.yaml $out/docker/envoy/
          cp ${self}/scripts/notify-send-wsl $out/scripts/
          cp -r ${nasBin}/share/nas/dist $out/ui/ || true
        '';

        nas = pkgs.runCommand "nas-wrapped" { } ''
          mkdir -p $out/bin $out/share/nas

          cp ${nasBin}/bin/nas $out/share/nas/nas
          cp -r ${nasAssets} $out/share/nas/assets

          cat > $out/bin/nas <<EOF
          #!/bin/sh
          dir="\$(cd "\$(dirname "\$0")/.." && pwd)"
          export NAS_ASSET_DIR="\$dir/share/nas/assets"
          exec "\$dir/share/nas/nas" "\$@"
          EOF
          chmod +x $out/bin/nas
        '';

        nasBundled = single-exe {
          name = "nas";
          target = "${nasBin}/bin/nas";
          type = "preload";
          extraFiles = { "share/nas/assets" = nasAssets; };
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
          ];
        };
      in
      {
        packages = {
          default = nas;
          bundled = nasBundled;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            b2n
            pkgs.nodejs
            pkgs.pnpm
            pkgs.chromium
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
