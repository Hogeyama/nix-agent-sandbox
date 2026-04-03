{
  description = "nas — Nix Agent Sandbox";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Phase 1: Fetch all dependencies into DENO_DIR (Fixed Output Derivation)
        nas-deps = pkgs.stdenv.mkDerivation {
          name = "nas-deps";
          src = self;
          nativeBuildInputs = [ pkgs.deno ];

          # FOD: needs network, output is hash-checked
          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = "sha256-ANp/QPjC9Fer35GiUtBJ0gp1+2BonnXnRcfhidUonj0=";

          buildPhase = ''
            export DENO_DIR="$out"
            export HOME=$(mktemp -d)

            # Cache all source dependencies (main app + build script + frontend)
            deno cache --lock=deno.lock main.ts
            deno cache --lock=deno.lock scripts/build_ui.ts
            deno cache --lock=deno.lock src/ui/frontend/src/main.tsx

            # Pre-cache the denort runtime binary that deno compile needs
            echo 'Deno.exit(0)' > /tmp/_dummy.ts
            deno compile --output /tmp/_dummy /tmp/_dummy.ts
          '';

          # The output IS the DENO_DIR
          installPhase = "true";
        };

        # Phase 2: Build the binary using cached deps
        nas = pkgs.stdenv.mkDerivation {
          pname = "nas";
          version = "0.1.0";
          src = self;
          nativeBuildInputs = [ pkgs.deno ];

          # deno compile embeds JS in a custom ELF section; strip destroys it
          dontStrip = true;

          buildPhase = ''
            export DENO_DIR=$(mktemp -d)
            export HOME=$(mktemp -d)

            # Copy cached deps (read-only store → writable tmpdir)
            cp -r ${nas-deps}/* "$DENO_DIR/"
            chmod -R u+w "$DENO_DIR"

            # Build UI (esbuild bundles frontend TSX → src/ui/dist/)
            deno task build-ui

            # Compile standalone binary
            deno compile --allow-all --cached-only \
              --include src/docker/embed/ \
              --include src/docker/envoy/ \
              --include src/ui/dist/ \
              --output nas main.ts
          '';

          installPhase = ''
            mkdir -p $out/bin
            cp nas $out/bin/
          '';
        };
      in
      {
        packages.default = nas;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.deno
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
