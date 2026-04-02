{
  description = "naw — Nix Agent Sandbox dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-bundle-elf.url = "github:Hogeyama/nix-bundle-elf";
    nix-bundle-elf.inputs.nixpkgs.follows = "nixpkgs";
    nix-bundle-elf.inputs.flake-utils.follows = "flake-utils";
  };

  outputs =
    { nixpkgs
    , flake-utils
    , nix-bundle-elf
    , ...
    }:
    flake-utils.lib.eachDefaultSystem (system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.default = pkgs.mkShell {
        packages = [
          pkgs.deno
          nix-bundle-elf.packages.${system}.default
        ];
      };
    });
}
