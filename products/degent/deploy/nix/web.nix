# NixOS module: services.degent-web (docs/DEPLOY.md). Exported by the root flake as nixosModules.degent-web.
# Serves the static front end from the Nix store through a Caddy virtual host, with the SAME site body as the
# container (../web-site.caddy: security headers + CSP, SPA fallback, immutable /assets, same-origin /api
# proxy to the mint API). The {$...} placeholders of that file are substituted here at evaluation time.
{ self ? null }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkOption mkIf types literalExpression;
  cfg = config.services.degent-web;
  mint = config.services.degent-mint or { enable = false; };

  site = builtins.replaceStrings
    [
      "{$MINT_API_UPSTREAM:mint-api:8787}"
      "{$WEB_ROOT:/srv}"
      "{$CSP_HEADER:Content-Security-Policy}"
      "{$CSP_IMG_SRC:https://ordinals.com}"
      "{$CSP_CONNECT_SRC:https://mempool.space}"
    ]
    [
      cfg.mintApiUpstream
      "${cfg.package}"
      (if cfg.cspReportOnly then "Content-Security-Policy-Report-Only" else "Content-Security-Policy")
      (lib.concatStringsSep " " cfg.cspImgSrc)
      (lib.concatStringsSep " " cfg.cspConnectSrc)
    ]
    (builtins.readFile ../web-site.caddy);
in
{
  options.services.degent-web = {
    enable = mkEnableOption "the degent.club web front end (static files behind a Caddy virtual host)";

    package = mkOption {
      type = types.package;
      default = if self != null then self.packages.${pkgs.stdenv.hostPlatform.system}.degent-web else throw "services.degent-web.package must be set";
      defaultText = literalExpression "degent.packages.\${system}.degent-web";
      description = ''
        Built front end (a directory with index.html). VITE_* values are compiled in, so build one per
        environment: `degent.packages.''${system}.degent-web.override { viteEnv = { VITE_NETWORK = "signet"; ... }; }`.
      '';
    };

    virtualHost = mkOption {
      type = types.str;
      example = "signet.degent.club";
      description = ''
        Caddy site address. A bare host name gets ACME TLS from Caddy; behind a TLS-terminating edge use
        "http://<host>" or ":<port>".
      '';
    };

    mintApiUpstream = mkOption {
      type = types.str;
      default = if mint.enable then "${mint.host}:${toString mint.port}" else "127.0.0.1:8787";
      defaultText = literalExpression ''"''${services.degent-mint.host}:''${toString services.degent-mint.port}"'';
      description = "host:port of the mint API that /api/* is proxied to.";
    };

    cspConnectSrc = mkOption {
      type = types.listOf types.str;
      default = [ "https://mempool.space" ];
      description = "Extra CSP connect-src origins: the browser-facing esplora (VITE_ESPLORA_URL) and the Telegram gate.";
    };

    cspImgSrc = mkOption {
      type = types.listOf types.str;
      default = [ "https://ordinals.com" ];
      description = "Extra CSP img-src origins: the browser-facing ord server (VITE_ORD_URL).";
    };

    cspReportOnly = mkOption {
      type = types.bool;
      default = false;
      description = "Send the CSP as report-only (rehearsal diagnosis of wallet extensions only).";
    };
  };

  config = mkIf cfg.enable {
    services.caddy.enable = true;
    services.caddy.virtualHosts.${cfg.virtualHost}.extraConfig = site;
  };
}
