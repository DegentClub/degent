# Nix packages for degent.club: `degent-mint` (bundled service + backup script) and `degent-web` (static
# front end, VITE_* baked in). Called from the root flake.nix; see docs/DEPLOY.md "Nix".
#
# Build strategy: pnpm workspace install from the lockfile with `pnpm_10.fetchDeps` (fixed-output, offline
# afterwards), then the same commands CI and the Dockerfiles run (`pnpm --filter <pkg> build`). The source
# includes the deps/scribbit submodule (the flake sets `inputs.self.submodules = true`, Nix >= 2.27; consumers
# use `git+https://...?submodules=1`).
#
# NOT YET BUILT WITH NIX: the fixed-output hashes below are placeholders (lib.fakeHash). The first
# `nix build .#degent-mint` prints the real hash ("got: sha256-..."); paste it into pnpmDepsHash and commit.
# Both packages share the deps hash only if their workspace filters are equal, so each has its own.
{ pkgs, src, lib ? pkgs.lib }:
let
  nodejs = pkgs.nodejs_22;
  pnpm = pkgs.pnpm_10;
  version = (builtins.fromJSON (builtins.readFile ../../services/mint/package.json)).version;

  # Only what a build needs: manifests, lockfile, the products tree and the platform packages.
  source = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.unions [
      (src + "/package.json")
      (src + "/pnpm-lock.yaml")
      (src + "/pnpm-workspace.yaml")
      (src + "/tsconfig.base.json")
      (src + "/products")
      (src + "/deps/scribbit/platform")
      (src + "/deps/scribbit/tsconfig.base.json")
    ];
  };

  workspaceBuild =
    { pname, filter, pnpmDepsHash, buildScript, installScript, env ? { }, nativeBuildInputs ? [ ] }:
    pkgs.stdenv.mkDerivation (finalAttrs: {
      inherit pname version env;
      src = source;
      pnpmWorkspaces = [ filter ];
      pnpmDeps = pnpm.fetchDeps {
        inherit (finalAttrs) pname version src pnpmWorkspaces;
        fetcherVersion = 2;
        hash = pnpmDepsHash;
      };
      nativeBuildInputs = [ nodejs pnpm.configHook pkgs.makeWrapper ] ++ nativeBuildInputs;
      buildPhase = ''
        runHook preBuild
        ${buildScript}
        runHook postBuild
      '';
      installPhase = ''
        runHook preInstall
        ${installScript}
        runHook postInstall
      '';
    });
in
{
  degent-mint = lib.makeOverridable
    ({ pnpmDepsHash ? lib.fakeHash }:
      workspaceBuild {
        pname = "degent-mint";
        filter = "@bsh/degent-mint...";
        inherit pnpmDepsHash;
        buildScript = "pnpm --filter @bsh/degent-mint build";
        installScript = ''
          svc=products/degent/services/mint
          mkdir -p $out/lib/degent-mint $out/bin
          cp -r $svc/dist $svc/data $svc/package.json $svc/env.schema.json $out/lib/degent-mint/
          # `degent-mint api|worker|all`; the roster resolves relative to $out/lib/degent-mint.
          makeWrapper ${nodejs}/bin/node $out/bin/degent-mint \
            --add-flags $out/lib/degent-mint/dist/main.mjs \
            --set-default NODE_OPTIONS --disable-warning=ExperimentalWarning
          install -Dm0755 products/degent/deploy/backup.sh $out/libexec/degent-mint-backup
          makeWrapper $out/libexec/degent-mint-backup $out/bin/degent-mint-backup \
            --prefix PATH : ${lib.makeBinPath [ pkgs.sqlite pkgs.age pkgs.coreutils pkgs.gzip pkgs.findutils pkgs.gnugrep ]}
        '';
      })
    { };

  # VITE_* values are compiled in. Override per environment, e.g.
  #   degent-web.override { viteEnv = { VITE_NETWORK = "signet"; VITE_ESPLORA_URL = "https://..."; }; }
  degent-web = lib.makeOverridable
    ({ pnpmDepsHash ? lib.fakeHash, viteEnv ? { VITE_NETWORK = "mainnet"; VITE_MINT_API_URL = "/api"; } }:
      workspaceBuild {
        pname = "degent-web";
        filter = "@bsh/degent-web...";
        inherit pnpmDepsHash;
        env = viteEnv;
        buildScript = "pnpm --filter @bsh/degent-web build";
        installScript = ''
          cp -r products/degent/apps/web/dist $out
          find $out -name '*.map' -delete
        '';
      })
    { };
}
