{
  description = "nas — Nix Agent Sandbox";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    deno2nix = {
      url = "github:aMOPel/deno2nix/deno-cli-fetcher";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, deno2nix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        deno2nixLib = import deno2nix { inherit pkgs; };

        # Read compile metadata from deno.json so flags aren't duplicated.
        denoJson = builtins.fromJSON (builtins.readFile "${self}/deno.json");
        compileMeta = denoJson."x-compile";

        # Pre-built denort binary from Deno GitHub releases.
        # Must match pkgs.deno version exactly — deno compile looks up
        # $DENO_DIR/dl/release/v<version>/denort-<target>.zip at build time.
        denort = let
          target = {
            "x86_64-linux"  = "x86_64-unknown-linux-gnu";
            "aarch64-linux" = "aarch64-unknown-linux-gnu";
            "x86_64-darwin"  = "x86_64-apple-darwin";
            "aarch64-darwin" = "aarch64-apple-darwin";
          }.${system};
          hash = {
            "x86_64-linux" = "sha256-kvYW0T9L7avvgeKAA0AwPGpybit8jrNg0y2oIXMWclQ=";
          }.${system};
        in pkgs.stdenvNoCC.mkDerivation {
          pname = "denort";
          version = pkgs.deno.version;
          src = pkgs.fetchurl {
            url = "https://github.com/denoland/deno/releases/download/v${pkgs.deno.version}/denort-${target}.zip";
            inherit hash;
          };
          nativeBuildInputs = [ pkgs.unzip ];
          dontUnpack = true;
          installPhase = ''
            mkdir -p $out/bin
            unzip $src -d $out/bin
            chmod +x $out/bin/denort
          '';
          meta.mainProgram = "denort";
        };

        # sha256 of the fetchDenoDeps FOD — update when deno.lock changes:
        # 1. Set to pkgs.lib.fakeHash, run `nix build`, copy the "got:" hash.
        denoDepsHash = "sha256-4mEmkw20Ou4I7jO19NT+ewE922VDcsidIyRy0tfec1Y=";

        nasDeps = deno2nixLib.lib.fetchDenoDeps {
          name = "nas-0.1.0-deno-deps";
          src = self;
          hash = denoDepsHash;
        };

        nas = deno2nixLib.lib.buildDenoPackage {
          pname = "nas";
          version = "0.1.0";
          src = self;

          denoDeps = nasDeps;

          preBuild = ''
            # Workaround: deno2nix build hook references $denoCompileFlags
            # but buildDenoPackage exports denoCompileFlags_ (with underscore).
            export denoCompileFlags="$denoCompileFlags_"
            export denoFlags="$denoFlags_"

            # Restore +x on esbuild native binary (stripped by cp --no-preserve=mode)
            find node_modules -type f -path '*/bin/*' -exec chmod +x {} \;

            # Build UI — native loader resolves npm:preact from node_modules
            deno task build-ui
          '';

          binaryEntrypointPath = compileMeta.entrypoint;
          denoCompileFlags = compileMeta.permissions
            ++ builtins.concatMap (p: ["--include" p]) compileMeta.includes;

          # Use pre-built denort from GitHub releases instead of the default
          # deno2nix denort which compiles Deno from Rust source (very slow).
          # The full pkgs.deno binary does NOT work as denort — the compiled
          # binary retains CLI parsing and ignores the embedded script.
          denortPackage = denort;

          # deno compile embeds JS in a custom ELF section; strip destroys it
          dontStrip = true;
          # patchelf --shrink-rpath corrupts the deno compile trailer
          dontPatchELF = true;
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
