{
  description = "degent.club: the non-custodial mint service and the web front end (docs/DEPLOY.md)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # deps/scribbit (the shared platform) is a git submodule and part of every build (Nix >= 2.27).
    self.submodules = true;
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # packages.<system>.degent-mint : bundled service, `degent-mint api|worker|all`, `degent-mint-backup`
      # packages.<system>.degent-web  : static front end (mainnet defaults; .override { viteEnv = ...; })
      packages = forAllSystems (pkgs:
        let p = import ./products/degent/deploy/nix/packages.nix { inherit pkgs; src = self; };
        in p // { default = p.degent-mint; });

      nixosModules = {
        degent-mint = import ./products/degent/deploy/nix/mint.nix { inherit self; };
        degent-web = import ./products/degent/deploy/nix/web.nix { inherit self; };
        default = { imports = [ self.nixosModules.degent-mint self.nixosModules.degent-web ]; };
      };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.sqlite ]; };
      });
    };
}
