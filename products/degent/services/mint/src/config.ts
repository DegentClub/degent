/**
 * Environment -> typed config. Mirrors env.schema.json. Fails fast with every problem listed,
 * and refuses unsafe combinations (mainnet with the in-memory dev signer, dev defaults off regtest).
 */
import { readFileSync } from 'node:fs';
import type { CollectionConfig, Network } from '@bsh/degent-mint-sdk';
import { DEFAULT_APPROVAL_QUORUM, DEFAULT_CONFIG, DEFAULT_DECLINE_QUORUM, DEFAULT_REVIEW_SLA_SECONDS, GALLERY_SIZE, MAX_UPLOAD_BYTES } from '@bsh/degent-mint-sdk';
import { DEFAULT_POLICY } from './domain/policy.js';
import { addressKind } from './domain/address.js';
import type { MintSettings } from './application/settings.js';

/**
 * Secrets that may be supplied as a file instead of a value: `<NAME>_FILE=/path` (Docker secrets, systemd
 * LoadCredential, SOPS-rendered files). Setting both `<NAME>` and `<NAME>_FILE` is an error. Must equal the
 * `x-secret` variables of env.schema.json except PARENT_KEY_FILE (already a file); test/config.test.ts checks.
 */
export const SECRET_FILE_VARS = ['LIBRE_RPC_PASS', 'SLIPSTREAM_API_KEY', 'REVEAL_ENCRYPTION_KEY', 'ART_REVIEW_API_KEY', 'SESSION_KEY', 'TELEGRAM_BOT_TOKEN'] as const;

/** Which loops this process runs: the HTTP API, the worker, or both (default; single-process dev). */
export type MintRole = 'all' | 'api' | 'worker';

export interface MintConfig {
  settings: MintSettings;
  role: MintRole;
  /** Mainnet without LIBRE_RPC_URL / SLIPSTREAM_URL: the block tier is not offered (standard lane only). */
  blockTierWithdrawn: boolean;
  port: number;
  host: string;
  databasePath: string | null; // null => in-memory store (regtest only)
  contentDir: string | null; // null => in-memory content (regtest only)
  esploraUrl: string;
  ordUrl: string;
  libre: { url: string; user: string; password: string } | null;
  slipstream: { url: string; apiKey: string | null } | null;
  parentOutpoint: { txid: string; vout: number } | null;
  signer: 'memory' | 'kms';
  parentKeyFile: string | null;
  revealEncryptionKey: string | null; // null => regtest dev key
  corsOrigins: string[];
  artReviewApiKey: string | null;
  artReviewGuidelinesFile: string | null;
  workerIntervalMs: number;
  rateLimitPerMinute: number;
  trustProxy: boolean;
  /** Roster JSON (the Gallery); relative paths resolve from the service directory. */
  rosterFile: string;
  holderRegistry: 'memory' | 'roster-chain';
  /** Ed25519 session signing key (hex); null => regtest dev key. */
  sessionKey: string | null;
  sessionKid: string;
  /** Order notifications (POST /v1/orders/{id}/subscriptions). */
  notify: {
    /** Public site origin used in notification links. */
    siteUrl: string;
    /** 'console' logs emails (dev); 'off' disables the email channel until a provider adapter is wired. */
    email: 'console' | 'off';
    /** Telegram Bot API token (secret); null disables the telegram_chat channel. */
    telegramBotToken: string | null;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** The collection tiers the service offers; the block tier only when a block-lane broadcaster exists (or off mainnet). */
export function offeredTiers(blockTierWithdrawn: boolean): CollectionConfig['tiers'] {
  const tiers = structuredClone(DEFAULT_CONFIG.tiers);
  return blockTierWithdrawn ? tiers.filter((t) => t.lane !== 'block') : tiers;
}

const NETWORKS: Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export function loadConfig(rawEnv: Record<string, string | undefined>, version = '0.1.0'): MintConfig {
  const problems: string[] = [];
  const env: Record<string, string | undefined> = { ...rawEnv };
  for (const k of SECRET_FILE_VARS) {
    const file = rawEnv[`${k}_FILE`]?.trim();
    if (!file) continue;
    if (rawEnv[k]?.trim()) {
      problems.push(`set ${k} or ${k}_FILE, not both`);
      continue;
    }
    try {
      env[k] = readFileSync(file, 'utf8').trim();
    } catch {
      problems.push(`${k}_FILE: cannot read ${file}`);
    }
  }
  const str = (k: string): string | null => {
    const v = env[k]?.trim();
    return v ? v : null;
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const v = str(k);
    if (v === null) return def;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      problems.push(`${k} must be an integer in ${min}..${max}`);
      return def;
    }
    return n;
  };
  const num = (k: string, def: number, min: number): number => {
    const v = str(k);
    if (v === null) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) {
      problems.push(`${k} must be a number >= ${min}`);
      return def;
    }
    return n;
  };
  const url = (k: string, def: string | null): string | null => {
    const v = str(k) ?? def;
    if (v === null) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      return v;
    } catch {
      problems.push(`${k} must be an http(s) URL`);
      return null;
    }
  };

  const networkRaw = str('NETWORK');
  const network = NETWORKS.includes(networkRaw as Network) ? (networkRaw as Network) : null;
  if (!network) problems.push(`NETWORK is required: one of ${NETWORKS.join(', ')}`);
  const net: Network = network ?? 'regtest';
  const dev = net === 'regtest';
  const need = (k: string) => {
    const v = str(k);
    if (v === null && !dev) problems.push(`${k} is required on ${net}`);
    return v;
  };

  const roleRaw = str('MINT_ROLE') ?? 'all';
  if (roleRaw !== 'all' && roleRaw !== 'api' && roleRaw !== 'worker') problems.push('MINT_ROLE must be "all", "api" or "worker"');
  const role: MintRole = roleRaw === 'api' || roleRaw === 'worker' ? roleRaw : 'all';
  if (role !== 'all' && dev && (!str('DATABASE_PATH') || !str('CONTENT_DIR')))
    problems.push('MINT_ROLE=api|worker needs a shared DATABASE_PATH and CONTENT_DIR (in-memory stores are per process)');

  const databasePath = need('DATABASE_PATH');
  const contentDir = need('CONTENT_DIR');
  const esploraUrl = url('ESPLORA_URL', dev ? 'http://127.0.0.1:3002' : null);
  if (!esploraUrl && !dev) problems.push('ESPLORA_URL is required');
  const ordUrl = url('ORD_URL', dev ? 'http://127.0.0.1:8080' : null);
  if (!ordUrl && !dev) problems.push('ORD_URL is required');

  const libreUrl = url('LIBRE_RPC_URL', null);
  const libre = libreUrl ? { url: libreUrl, user: str('LIBRE_RPC_USER') ?? '', password: str('LIBRE_RPC_PASS') ?? '' } : null;
  const slipUrl = url('SLIPSTREAM_URL', null);
  const slipstream = slipUrl ? { url: slipUrl, apiKey: str('SLIPSTREAM_API_KEY') } : null;
  // Mainnet never falls back to esplora for non-standard Block Degent reveals: without Libre Relay or Slipstream
  // the block tier is withdrawn (standard lane only; /v1/config stops offering it, block orders fail validation).
  const blockTierWithdrawn = net === 'mainnet' && !libre && !slipstream;

  const parentInscriptionId = str('PARENT_INSCRIPTION_ID');
  if (parentInscriptionId && !/^[0-9a-f]{64}i\d+$/.test(parentInscriptionId))
    problems.push('PARENT_INSCRIPTION_ID must look like <txid>i<index>');
  if (!parentInscriptionId && !dev) problems.push(`PARENT_INSCRIPTION_ID is required on ${net}`);

  let parentOutpoint: MintConfig['parentOutpoint'] = null;
  const po = str('PARENT_OUTPOINT');
  if (po) {
    const m = /^([0-9a-f]{64}):(\d+)$/.exec(po);
    if (!m) problems.push('PARENT_OUTPOINT must be <txid>:<vout>');
    else parentOutpoint = { txid: m[1]!, vout: Number(m[2]) };
  }

  const signerRaw = str('SIGNER') ?? 'memory';
  if (signerRaw !== 'memory' && signerRaw !== 'kms') problems.push('SIGNER must be "memory" or "kms"');
  const signer = signerRaw === 'kms' ? 'kms' : 'memory';
  if (signer === 'kms') problems.push('SIGNER=kms is not implemented yet (see adapters/kms-policy-signer.ts)');
  if (net === 'mainnet' && signer === 'memory')
    problems.push('refusing to start on mainnet with the in-memory dev policy signer (SIGNER=memory)');
  const parentKeyFile = str('PARENT_KEY_FILE');
  if (parentKeyFile && net === 'mainnet') problems.push('PARENT_KEY_FILE is dev-only and not accepted on mainnet');
  if (!parentKeyFile && signer === 'memory' && !dev && net !== 'mainnet') problems.push(`PARENT_KEY_FILE is required on ${net} with SIGNER=memory`);

  const collectionAddress = str('COLLECTION_ADDRESS');
  if (collectionAddress && addressKind(collectionAddress, net) !== 'tr')
    problems.push(`COLLECTION_ADDRESS must be a taproot address on ${net}`);
  if (!collectionAddress && !dev) problems.push(`COLLECTION_ADDRESS is required on ${net}`);

  const revealEncryptionKey = str('REVEAL_ENCRYPTION_KEY');
  if (revealEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(revealEncryptionKey))
    problems.push('REVEAL_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)');
  if (!revealEncryptionKey && !dev) problems.push(`REVEAL_ENCRYPTION_KEY is required on ${net} (dev default is regtest-only)`);

  const serviceFeeAddress = str('SERVICE_FEE_ADDRESS');
  const feeStd = int('SERVICE_FEE_SATS_STANDARD', 0, 0, 10_000_000);
  const feeBlk = int('SERVICE_FEE_SATS_BLOCK', 0, 0, 10_000_000);
  if ((feeStd > 0 || feeBlk > 0) && !serviceFeeAddress) problems.push('SERVICE_FEE_ADDRESS is required when a service fee is set');
  if (serviceFeeAddress && addressKind(serviceFeeAddress, net) === null) problems.push(`SERVICE_FEE_ADDRESS is not a ${net} address`);

  const corsOrigins = (str('CORS_ORIGINS') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const o of corsOrigins) {
    try {
      if (new URL(o).origin !== o) throw new Error();
    } catch {
      problems.push(`CORS_ORIGINS entry "${o}" must be an exact origin like https://degent.club`);
    }
  }

  const minFeeRate = num('MIN_FEE_RATE', DEFAULT_CONFIG.minFeeRate, 0.1);
  const standardConcurrency = int('STANDARD_CONCURRENCY', 12, 1, 24);
  const confirmations = int('CONFIRMATIONS', 1, 1, 100);
  const rescueAfterSeconds = int('RESCUE_AFTER_SECONDS', DEFAULT_CONFIG.rescueAfterSeconds, 600, 7 * 86_400);
  const quoteTtlSeconds = int('QUOTE_TTL_SECONDS', DEFAULT_CONFIG.quoteTtlSeconds, 60, 86_400);

  // Member approval (ADR-0007)
  const approvalQuorum = int('APPROVAL_QUORUM', DEFAULT_APPROVAL_QUORUM, 1, 100);
  const declineQuorum = int('DECLINE_QUORUM', DEFAULT_DECLINE_QUORUM, 1, 100);
  const reviewSlaSeconds = int('REVIEW_SLA_SECONDS', DEFAULT_REVIEW_SLA_SECONDS, 3600, 90 * 86_400);
  const siwbDomain = str('SIWB_DOMAIN') ?? (dev ? 'localhost:8787' : null);
  if (!siwbDomain) problems.push(`SIWB_DOMAIN is required on ${net} (the host holder sign-ins are bound to)`);
  else if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(siwbDomain)) problems.push('SIWB_DOMAIN must be a lower-case host[:port]');
  const siwbUri = str('SIWB_URI') ?? (dev ? `http://${siwbDomain}` : null);
  const sessionKey = str('SESSION_KEY');
  if (sessionKey && !/^[0-9a-fA-F]{64}$/.test(sessionKey)) problems.push('SESSION_KEY must be 32 bytes of hex (64 characters)');
  if (!sessionKey && !dev) problems.push(`SESSION_KEY is required on ${net} (dev default is regtest-only)`);
  const sessionKid = str('SESSION_KID') ?? 'k1';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sessionKid)) problems.push('SESSION_KID must be 1-64 of [A-Za-z0-9._-]');
  const holderRaw = str('HOLDER_REGISTRY') ?? (dev ? 'memory' : 'roster-chain');
  if (holderRaw !== 'memory' && holderRaw !== 'roster-chain') problems.push('HOLDER_REGISTRY must be "memory" or "roster-chain"');
  if (holderRaw === 'memory' && net === 'mainnet') problems.push('HOLDER_REGISTRY=memory is dev-only and refused on mainnet');
  const galleryInscriptionId = str('GALLERY_INSCRIPTION_ID');
  if (galleryInscriptionId && !/^[0-9a-f]{64}i\d+$/.test(galleryInscriptionId)) problems.push('GALLERY_INSCRIPTION_ID must look like <txid>i<index>');
  const ordPublicUrl = url('ORD_PUBLIC_URL', ordUrl ?? 'https://ordinals.com');
  const siteUrl = url('SITE_URL', 'https://degent.club');
  const notifyEmailRaw = str('NOTIFY_EMAIL') ?? (dev ? 'console' : 'off');
  if (notifyEmailRaw !== 'console' && notifyEmailRaw !== 'off') problems.push('NOTIFY_EMAIL must be "console" or "off"');
  if (notifyEmailRaw === 'console' && net === 'mainnet') problems.push('NOTIFY_EMAIL=console is dev-only and refused on mainnet');
  const telegramBotToken = str('TELEGRAM_BOT_TOKEN');
  if (telegramBotToken && !/^\d{5,20}:[A-Za-z0-9_-]{20,64}$/.test(telegramBotToken)) problems.push('TELEGRAM_BOT_TOKEN does not look like a Bot API token');

  const out: MintConfig = {
    role,
    blockTierWithdrawn,
    settings: {
      network: net,
      version,
      collection: {
        ...structuredClone(DEFAULT_CONFIG),
        tiers: offeredTiers(blockTierWithdrawn),
        network: net,
        parentInscriptionId,
        minFeeRate,
        quoteTtlSeconds,
        rescueAfterSeconds,
        serviceFeeSats: { standard: feeStd, block: feeBlk },
      } satisfies CollectionConfig,
      collectionAddress: collectionAddress ?? '',
      serviceFeeAddress,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      standardConcurrency,
      confirmations,
      latePaymentWindowSeconds: int('LATE_PAYMENT_WINDOW_SECONDS', 7 * 86_400, 0, 30 * 86_400),
      policy: {
        ...DEFAULT_POLICY,
        bands: {
          standard: { ...DEFAULT_POLICY.bands.standard, minFeeRate },
          block: { ...DEFAULT_POLICY.bands.block, minFeeRate },
        },
      },
      approval: { approvalQuorum, declineQuorum, reviewSlaSeconds, gallerySize: GALLERY_SIZE },
      auth: {
        domain: siwbDomain ?? 'localhost:8787',
        uri: siwbUri,
        challengeTtlSeconds: int('SIWB_CHALLENGE_TTL_SECONDS', 300, 30, 3600),
        sessionTtlSeconds: int('SESSION_TTL_SECONDS', 3600, 60, 30 * 86_400),
        audience: 'degent',
      },
      ordPublicUrl: ordPublicUrl ?? 'https://ordinals.com',
      galleryInscriptionId,
    },
    port: int('PORT', 8787, 1, 65_535),
    host: str('HOST') ?? '127.0.0.1',
    databasePath,
    contentDir,
    esploraUrl: esploraUrl ?? '',
    ordUrl: ordUrl ?? '',
    libre,
    slipstream,
    parentOutpoint,
    signer,
    parentKeyFile,
    revealEncryptionKey,
    corsOrigins,
    artReviewApiKey: str('ART_REVIEW_API_KEY'),
    artReviewGuidelinesFile: str('ART_REVIEW_GUIDELINES_FILE'),
    workerIntervalMs: int('WORKER_INTERVAL_MS', 15_000, 1_000, 600_000),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60, 1, 100_000),
    trustProxy: str('TRUST_PROXY') === 'true',
    rosterFile: str('ROSTER_FILE') ?? 'data/roster.json',
    holderRegistry: holderRaw === 'roster-chain' ? 'roster-chain' : 'memory',
    sessionKey,
    sessionKid,
    notify: {
      siteUrl: (siteUrl ?? 'https://degent.club').replace(/\/+$/, ''),
      email: notifyEmailRaw === 'console' ? 'console' : 'off',
      telegramBotToken,
    },
  };
  if (problems.length) throw new ConfigError(problems);
  return out;
}
