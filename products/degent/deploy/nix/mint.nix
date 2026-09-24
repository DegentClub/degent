# NixOS module: services.degent-mint (docs/DEPLOY.md). Exported by the root flake as
# nixosModules.degent-mint. Two hardened units share one sqlite state directory:
#   degent-mint-api     HTTP API        (MINT_ROLE=api)
#   degent-mint-worker  the order loop  (MINT_ROLE=worker, exactly one)
# plus an optional degent-mint-backup timer (sqlite online backup + content blobs).
#
# SOPS-friendly: every secret is a `*File` option (a path, e.g. config.sops.secrets."...".path). Files are
# handed to the units with systemd LoadCredential, so they can stay root-owned 0400; the service reads
# them through the <NAME>_FILE variables (services/mint/src/config.ts). No secret ever enters the Nix store.
{ self ? null }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkOption mkIf types literalExpression optionalAttrs filterAttrs mapAttrs' nameValuePair;
  cfg = config.services.degent-mint;

  secretFile = description: mkOption {
    type = types.nullOr types.path;
    default = null;
    inherit description;
    example = literalExpression ''config.sops.secrets."services/degent-mint/<name>".path'';
  };

  # env.schema.json variable -> credential name -> option. test/deploy.test.ts checks this table against the schema.
  credentials = filterAttrs (_: c: c.file != null) {
    REVEAL_ENCRYPTION_KEY = { name = "reveal-encryption-key"; file = cfg.revealEncryptionKeyFile; };
    SESSION_KEY = { name = "session-key"; file = cfg.sessionKeyFile; };
    LIBRE_RPC_PASS = { name = "libre-rpc-pass"; file = cfg.libreRpcPassFile; };
    SLIPSTREAM_API_KEY = { name = "slipstream-api-key"; file = cfg.slipstreamApiKeyFile; };
    ART_REVIEW_API_KEY = { name = "art-review-api-key"; file = cfg.artReviewApiKeyFile; };
    TELEGRAM_BOT_TOKEN = { name = "telegram-bot-token"; file = cfg.telegramBotTokenFile; };
    PARENT_KEY = { name = "parent-key"; file = cfg.parentKeyFile; };
  };
  # PARENT_KEY_FILE is itself a file variable; the others are <NAME>_FILE twins.
  credentialEnv = mapAttrs' (var: c: nameValuePair "${var}_FILE" "%d/${c.name}") credentials;

  # env.schema.json variable -> option. Unset (null) options are left out so the service defaults apply.
  env = filterAttrs (_: v: v != null) ({
    NETWORK = cfg.network;
    HOST = cfg.host;
    PORT = toString cfg.port;
    DATABASE_PATH = "${cfg.stateDir}/mint.db";
    CONTENT_DIR = "${cfg.stateDir}/content";
    ESPLORA_URL = cfg.esploraUrl;
    ORD_URL = cfg.ordUrl;
    ORD_PUBLIC_URL = cfg.ordPublicUrl;
    LIBRE_RPC_URL = cfg.libreRpcUrl;
    LIBRE_RPC_USER = cfg.libreRpcUser;
    SLIPSTREAM_URL = cfg.slipstreamUrl;
    PARENT_INSCRIPTION_ID = cfg.parentInscriptionId;
    PARENT_OUTPOINT = cfg.parentOutpoint;
    COLLECTION_ADDRESS = cfg.collectionAddress;
    SIGNER = cfg.signer;
    CORS_ORIGINS = lib.concatStringsSep "," cfg.corsOrigins;
    TRUST_PROXY = lib.boolToString cfg.trustProxy;
    SIWB_DOMAIN = cfg.siwbDomain;
    HOLDER_REGISTRY = cfg.holderRegistry;
    ROSTER_FILE = if cfg.rosterFile == null then null else toString cfg.rosterFile;
  } // cfg.settings) // credentialEnv;

  hardening = {
    User = "degent-mint";
    Group = "degent-mint";
    StateDirectory = "degent-mint";
    StateDirectoryMode = "0700";
    WorkingDirectory = cfg.stateDir;
    UMask = "0077";
    LoadCredential = lib.mapAttrsToList (_: c: "${c.name}:${toString c.file}") credentials;
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    PrivateUsers = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    ProtectProc = "invisible";
    ProcSubset = "pid";
    RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
    RestrictNamespaces = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    RemoveIPC = true;
    LockPersonality = true;
    # V8 JIT needs writable+executable pages.
    MemoryDenyWriteExecute = false;
    CapabilityBoundingSet = "";
    AmbientCapabilities = "";
    SystemCallArchitectures = "native";
    SystemCallFilter = [ "@system-service" "~@privileged" "~@resources" ];
  };

  unit = role: description: {
    inherit description;
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    environment = env // { MINT_ROLE = role; } // optionalAttrs (role == "worker") { PORT = toString cfg.workerHealthPort; };
    serviceConfig = hardening // {
      ExecStart = "${cfg.package}/bin/degent-mint ${role}";
      EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
      Restart = "on-failure";
      RestartSec = 5;
      # SIGTERM: stop the worker loop after the current tick, close sqlite.
      TimeoutStopSec = 60;
    };
  };
in
{
  options.services.degent-mint = {
    enable = mkEnableOption "the degent.club mint service (API + worker)";

    package = mkOption {
      type = types.package;
      default = if self != null then self.packages.${pkgs.stdenv.hostPlatform.system}.degent-mint else throw "services.degent-mint.package must be set";
      defaultText = literalExpression "degent.packages.\${system}.degent-mint";
      description = "The degent-mint package (bundled service, `degent-mint` and `degent-mint-backup` binaries).";
    };

    network = mkOption {
      type = types.enum [ "mainnet" "testnet" "signet" "regtest" ];
      description = "Bitcoin network (NETWORK). mainnet refuses the dev signer and key files.";
    };

    host = mkOption { type = types.str; default = "127.0.0.1"; description = "API listen address (HOST)."; };
    port = mkOption { type = types.port; default = 8787; description = "API listen port (PORT)."; };
    workerHealthPort = mkOption { type = types.port; default = 8788; description = "Port on which the worker serves GET /v1/health only (bound to `host`)."; };
    openFirewall = mkOption { type = types.bool; default = false; description = "Open `port` (only when the API must be reached from other hosts, not via the local web vhost)."; };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/degent-mint";
      readOnly = true;
      description = "sqlite database (mint.db) and content blobs (content/). Managed by StateDirectory.";
    };

    esploraUrl = mkOption { type = types.nullOr types.str; default = null; example = "http://10.40.0.103:8999/api"; description = "ESPLORA_URL: esplora REST base; also the standard-lane broadcaster."; };
    ordUrl = mkOption { type = types.nullOr types.str; default = null; example = "http://10.40.0.217:8080"; description = "ORD_URL: ord server used to verify delivered bytes and holder ownership."; };
    ordPublicUrl = mkOption { type = types.nullOr types.str; default = null; description = "ORD_PUBLIC_URL: public ord base for explorer image URLs (defaults to ordUrl)."; };
    libreRpcUrl = mkOption { type = types.nullOr types.str; default = null; example = "http://10.40.0.227:8332"; description = "LIBRE_RPC_URL: Libre Relay JSON-RPC (block lane). Unset on mainnet (and no Slipstream) = standard lane only."; };
    libreRpcUser = mkOption { type = types.nullOr types.str; default = null; description = "LIBRE_RPC_USER."; };
    slipstreamUrl = mkOption { type = types.nullOr types.str; default = null; description = "SLIPSTREAM_URL: MARA Slipstream (block lane)."; };
    parentInscriptionId = mkOption { type = types.nullOr types.str; default = null; description = "PARENT_INSCRIPTION_ID: the collection parent (<txid>i<n>)."; };
    parentOutpoint = mkOption { type = types.nullOr types.str; default = null; description = "PARENT_OUTPOINT: initial parent location (<txid>:<vout>), read only while the store has none."; };
    collectionAddress = mkOption { type = types.nullOr types.str; default = null; description = "COLLECTION_ADDRESS: taproot address of the parent key (must equal the signer's)."; };
    signer = mkOption { type = types.enum [ "memory" "kms" ]; default = "memory"; description = "SIGNER. memory = dev key file (refused on mainnet); kms is not implemented yet (the service refuses to start)."; };
    corsOrigins = mkOption { type = types.listOf types.str; default = [ ]; example = [ "https://degent.club" ]; description = "CORS_ORIGINS: exact web origins (browsers send Origin on same-origin POSTs too)."; };
    trustProxy = mkOption { type = types.bool; default = true; description = "TRUST_PROXY: take the client IP from X-Forwarded-For (the local Caddy vhost is the only client)."; };
    siwbDomain = mkOption { type = types.nullOr types.str; default = null; example = "degent.club"; description = "SIWB_DOMAIN: host holder sign-ins are bound to."; };
    holderRegistry = mkOption { type = types.nullOr (types.enum [ "memory" "roster-chain" ]); default = null; description = "HOLDER_REGISTRY (default roster-chain off regtest)."; };
    rosterFile = mkOption { type = types.nullOr types.path; default = null; description = "ROSTER_FILE: Gallery roster JSON; null = the packaged data/roster.json."; };

    settings = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = { APPROVAL_QUORUM = "3"; REVIEW_SLA_SECONDS = "1209600"; MIN_FEE_RATE = "2"; };
      description = "Any other non-secret variable from services/mint/env.schema.json, verbatim.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Optional EnvironmentFile (e.g. a sops template) for non-secret overrides. Secrets belong in the *File options.";
    };

    # ---- secrets: paths only (SOPS: config.sops.secrets."services/degent-mint/<name>".path)
    revealEncryptionKeyFile = secretFile "REVEAL_ENCRYPTION_KEY: 32-byte hex AES key for stored half-signed reveals. Required off regtest.";
    sessionKeyFile = secretFile "SESSION_KEY: 32-byte hex Ed25519 key signing holder sessions. Required off regtest.";
    libreRpcPassFile = secretFile "LIBRE_RPC_PASS: Libre Relay RPC password.";
    slipstreamApiKeyFile = secretFile "SLIPSTREAM_API_KEY: MARA Slipstream API key.";
    artReviewApiKeyFile = secretFile "ART_REVIEW_API_KEY: vision art review API key (unset = rules-only review).";
    telegramBotTokenFile = secretFile "TELEGRAM_BOT_TOKEN: Telegram Bot API token for order notifications (unset = telegram channel off).";
    parentKeyFile = secretFile "PARENT_KEY_FILE: DEV/SIGNET ONLY hex parent key for SIGNER=memory. Refused on mainnet.";

    backup = {
      enable = mkEnableOption "periodic sqlite online backups of the mint database and content blobs";
      directory = mkOption { type = types.str; default = "/var/backup/degent-mint"; description = "Backup target (ship it off-host; it holds encrypted reveals)."; };
      onCalendar = mkOption { type = types.str; default = "hourly"; description = "systemd OnCalendar for the backup timer."; };
      keep = mkOption { type = types.ints.positive; default = 48; description = "Database snapshots to keep."; };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      { assertion = cfg.network != "mainnet" || (cfg.parentKeyFile == null && cfg.signer == "kms");
        message = "services.degent-mint: mainnet needs signer = \"kms\" and no parentKeyFile (the dev signer is refused)."; }
      { assertion = cfg.network == "regtest" || (cfg.revealEncryptionKeyFile != null && cfg.sessionKeyFile != null);
        message = "services.degent-mint: revealEncryptionKeyFile and sessionKeyFile are required off regtest."; }
      { assertion = cfg.network == "regtest" || lib.all (x: x != null) [ cfg.esploraUrl cfg.ordUrl cfg.parentInscriptionId cfg.collectionAddress cfg.siwbDomain ];
        message = "services.degent-mint: esploraUrl, ordUrl, parentInscriptionId, collectionAddress and siwbDomain are required off regtest."; }
      { assertion = cfg.network == "mainnet" || cfg.network == "regtest" || cfg.signer != "memory" || cfg.parentKeyFile != null;
        message = "services.degent-mint: SIGNER=memory off regtest needs parentKeyFile."; }
    ];

    users.users.degent-mint = { isSystemUser = true; group = "degent-mint"; home = cfg.stateDir; };
    users.groups.degent-mint = { };

    systemd.services.degent-mint-api = unit "api" "degent.club mint API";
    systemd.services.degent-mint-worker = unit "worker" "degent.club mint worker (one instance: the parent chain is serial)";

    systemd.tmpfiles.rules = lib.optional cfg.backup.enable "d ${cfg.backup.directory} 0700 degent-mint degent-mint - -";

    systemd.services.degent-mint-backup = mkIf cfg.backup.enable {
      description = "degent-mint sqlite online backup";
      environment = {
        DATABASE_PATH = "${cfg.stateDir}/mint.db";
        CONTENT_DIR = "${cfg.stateDir}/content";
        BACKUP_DIR = cfg.backup.directory;
        BACKUP_KEEP = toString cfg.backup.keep;
      };
      serviceConfig = hardening // {
        Type = "oneshot";
        ExecStart = "${cfg.package}/bin/degent-mint-backup";
        LoadCredential = [ ];
        ReadWritePaths = [ cfg.backup.directory ];
      };
    };
    systemd.timers.degent-mint-backup = mkIf cfg.backup.enable {
      wantedBy = [ "timers.target" ];
      timerConfig = { OnCalendar = cfg.backup.onCalendar; Persistent = true; RandomizedDelaySec = "5m"; };
    };

    networking.firewall.allowedTCPPorts = lib.optional cfg.openFirewall cfg.port;
  };
}
