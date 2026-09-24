/**
 * Environment -> typed config. Mirrors env.schema.json. Fails fast with every problem listed,
 * and refuses unsafe combinations (mainnet with the in-memory dev signer, dev defaults off regtest,
 * in-memory stores off regtest, mainnet without the event bus).
 */
import { API_KEY_RE, type ApiKeyEnv, type ApiKeyRecord } from '@bsh/edge';
import type { CollectionConfig, Network } from '@bsh/degent-mint-sdk';
import { DEFAULT_CLUB_FEE_BPS, DEFAULT_CONFIG, DEFAULT_ROYALTY_BPS, MAX_UPLOAD_BYTES } from '@bsh/degent-mint-sdk';
import { DEFAULT_POLICY } from './domain/policy.js';
import { addressKind } from './domain/address.js';
import type { MintSettings } from './application/settings.js';
import { SCOPE_MINT_ADMIN } from './admin.js';

export interface MintConfig {
  settings: MintSettings;
  port: number;
  host: string;
  databasePath: string | null; // null => in-memory store (regtest only)
  contentDir: string | null; // null => in-memory content (regtest only)
  esploraUrl: string;
  ordUrl: string;
  libre: { url: string; user: string; password: string } | null;
  slipstream: { url: string; apiKey: string | null } | null;
  parentOutpoint: { txid: string; vout: number } | null;
  signer: 'memory' | 'remote';
  /** `SIGNER=remote`: the platform signer service (@bsh/signer). */
  remoteSigner: { url: string; apiKey: string; keyId: string; timeoutMs: number; retries: number } | null;
  parentKeyFile: string | null;
  revealEncryptionKey: string | null; // null => regtest dev key
  corsOrigins: string[];
  artReviewApiKey: string | null;
  artReviewGuidelinesFile: string | null;
  workerIntervalMs: number;
  rateLimitPerMinute: number;
  trustProxy: boolean;
  /** Open Studio: the Artist Studio (artwork orders). null => disabled (regtest wires an in-memory fake). */
  studio: { url: string; apiKey: string | null } | null;
  /** Open Studio: the platform ledger (plan §3.5). null => not recorded (regtest wires an in-memory fake). */
  ledger: { url: string; apiKey: string | null } | null;
  /** `POST /v1/admin/*` keys (hash-only @bsh/edge records, scope `mint:admin`). Empty = admin endpoints refuse everyone. */
  adminApiKeys: ApiKeyRecord[];
  adminApiKeyEnvironment: ApiKeyEnv;
  /** RabbitMQ through @bsh/events `connectAmqpBus`. null => events stay in-process (regtest; warned on signet/testnet; refused on mainnet). */
  bus: { url: string; exchange: string; connectTimeoutMs: number } | null;
  /** Non-fatal findings main.ts logs at startup. */
  warnings: string[];
}

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const NETWORKS: Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export function loadConfig(env: Record<string, string | undefined>, version = '0.1.0'): MintConfig {
  const problems: string[] = [];
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

  // Durable by default (p5.3): off regtest the stores are node:sqlite (orders, encrypted reveals, editions,
  // parent state) and the content store is the filesystem. There is no in-memory fallback to fall into.
  const databasePath = str('DATABASE_PATH');
  if (!databasePath && !dev) problems.push(`DATABASE_PATH is required on ${net}: production networks never run in-memory stores`);
  const contentDir = str('CONTENT_DIR');
  if (!contentDir && !dev) problems.push(`CONTENT_DIR is required on ${net}: production networks never run an in-memory content store`);
  const esploraUrl = url('ESPLORA_URL', dev ? 'http://127.0.0.1:3002' : null);
  if (!esploraUrl && !dev) problems.push('ESPLORA_URL is required');
  const ordUrl = url('ORD_URL', dev ? 'http://127.0.0.1:8080' : null);
  if (!ordUrl && !dev) problems.push('ORD_URL is required');

  const libreUrl = url('LIBRE_RPC_URL', null);
  const libre = libreUrl ? { url: libreUrl, user: str('LIBRE_RPC_USER') ?? '', password: str('LIBRE_RPC_PASS') ?? '' } : null;
  const slipUrl = url('SLIPSTREAM_URL', null);
  const slipstream = slipUrl ? { url: slipUrl, apiKey: str('SLIPSTREAM_API_KEY') } : null;
  if (net === 'mainnet' && !libre && !slipstream)
    problems.push('mainnet needs a block-lane broadcaster: set LIBRE_RPC_URL and/or SLIPSTREAM_URL');

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
  if (signerRaw === 'kms')
    problems.push('SIGNER=kms is retired: use SIGNER=remote (the platform signer service @bsh/signer fronts the KMS/HSM; RUNBOOK section 7)');
  else if (signerRaw !== 'memory' && signerRaw !== 'remote') problems.push('SIGNER must be "memory" (dev) or "remote"');
  const signer: MintConfig['signer'] = signerRaw === 'remote' ? 'remote' : 'memory';
  if (net === 'mainnet' && signer === 'memory')
    problems.push('refusing to start on mainnet with the in-memory dev policy signer (SIGNER=memory)');
  const parentKeyFile = str('PARENT_KEY_FILE');
  if (parentKeyFile && net === 'mainnet') problems.push('PARENT_KEY_FILE is dev-only and not accepted on mainnet');
  if (parentKeyFile && signer === 'remote') problems.push('PARENT_KEY_FILE is only read with SIGNER=memory; with SIGNER=remote the key stays in the signer service');
  if (!parentKeyFile && signer === 'memory' && !dev && net !== 'mainnet') problems.push(`PARENT_KEY_FILE is required on ${net} with SIGNER=memory`);
  let remoteSigner: MintConfig['remoteSigner'] = null;
  const signerUrl = url('SIGNER_URL', null);
  const signerApiKey = str('SIGNER_API_KEY');
  const signerKeyId = str('SIGNER_KEY_ID');
  const signerTimeoutMs = int('SIGNER_TIMEOUT_MS', 10_000, 500, 120_000);
  const signerRetries = int('SIGNER_RETRIES', 2, 0, 10);
  if (signer === 'remote') {
    if (!signerUrl) problems.push('SIGNER_URL is required with SIGNER=remote (base URL of the platform signer service)');
    if (!signerApiKey) problems.push('SIGNER_API_KEY is required with SIGNER=remote (API key with scope sign:<SIGNER_KEY_ID>)');
    else {
      const m = API_KEY_RE.exec(signerApiKey);
      if (!m) problems.push('SIGNER_API_KEY must be a @bsh/edge API key (bsh_live_... or bsh_test_...)');
      else if (net === 'mainnet' && m[1] !== 'live') problems.push('SIGNER_API_KEY must be a live key (bsh_live_...) on mainnet');
    }
    if (!signerKeyId) problems.push('SIGNER_KEY_ID is required with SIGNER=remote (the signer key id holding the collection key)');
    else if (!KEY_ID_RE.test(signerKeyId)) problems.push('SIGNER_KEY_ID must be alphanumerics, ".", "_" or "-" (max 64)');
    if (signerUrl && signerApiKey && signerKeyId)
      remoteSigner = { url: signerUrl, apiKey: signerApiKey, keyId: signerKeyId, timeoutMs: signerTimeoutMs, retries: signerRetries };
  }

  const collectionAddress = str('COLLECTION_ADDRESS');
  if (collectionAddress && addressKind(collectionAddress, net) !== 'tr')
    problems.push(`COLLECTION_ADDRESS must be a taproot address on ${net}`);
  if (!collectionAddress && !dev) problems.push(`COLLECTION_ADDRESS is required on ${net}`);
  else if (!collectionAddress && signer === 'remote') problems.push('COLLECTION_ADDRESS is required with SIGNER=remote (checked against the signer key at startup)');

  const revealEncryptionKey = str('REVEAL_ENCRYPTION_KEY');
  if (revealEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(revealEncryptionKey))
    problems.push('REVEAL_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)');
  if (!revealEncryptionKey && !dev) problems.push(`REVEAL_ENCRYPTION_KEY is required on ${net} (dev default is regtest-only)`);

  const parentValueSats = int('PARENT_VALUE_SATS', 10_000, 330, 100_000_000);

  const serviceFeeAddress = str('SERVICE_FEE_ADDRESS');
  const feeStd = int('SERVICE_FEE_SATS_STANDARD', 0, 0, 10_000_000);
  const feeLarge = int('SERVICE_FEE_SATS_LARGE', 0, 0, 10_000_000);
  const feeFull = int('SERVICE_FEE_SATS_FULLBLOCK', 0, 0, 10_000_000);
  if ((feeStd > 0 || feeLarge > 0 || feeFull > 0) && !serviceFeeAddress) problems.push('SERVICE_FEE_ADDRESS is required when a service fee is set');
  if (serviceFeeAddress && addressKind(serviceFeeAddress, net) === null) problems.push(`SERVICE_FEE_ADDRESS is not a ${net} address`);

  // Open Studio (ADR-0007, plan §3): studio, ledger, royalty and club fee in basis points.
  const studioUrl = url('STUDIO_URL', null);
  const studioApiKey = str('STUDIO_API_KEY');
  if (studioUrl && !studioApiKey && !dev) problems.push('STUDIO_API_KEY (scope studio:internal) is required when STUDIO_URL is set');
  const ledgerUrl = url('LEDGER_URL', null);
  const ledgerApiKey = str('LEDGER_API_KEY');
  if (ledgerUrl && !ledgerApiKey && !dev) problems.push('LEDGER_API_KEY (scope ledger) is required when LEDGER_URL is set');
  const royaltyBps = int('ROYALTY_BPS', DEFAULT_ROYALTY_BPS, 0, 10_000);
  const clubFeeBps = {
    standard: int('CLUB_FEE_BPS_STANDARD', DEFAULT_CLUB_FEE_BPS, 0, 10_000),
    large: int('CLUB_FEE_BPS_LARGE', DEFAULT_CLUB_FEE_BPS, 0, 10_000),
    fullblock: int('CLUB_FEE_BPS_FULLBLOCK', DEFAULT_CLUB_FEE_BPS, 0, 10_000),
  };
  if (studioUrl && (clubFeeBps.standard > 0 || clubFeeBps.large > 0 || clubFeeBps.fullblock > 0) && !serviceFeeAddress)
    problems.push('SERVICE_FEE_ADDRESS is required for artwork orders when a club fee is set (CLUB_FEE_BPS_*)');

  // Admin API keys (p5.2): hash-only @bsh/edge records, like the other services' API_KEYS.
  const adminApiKeyEnvironment: ApiKeyEnv = net === 'mainnet' ? 'live' : 'test';
  const adminApiKeys: ApiKeyRecord[] = [];
  const adminRaw = str('MINT_ADMIN_API_KEYS_JSON');
  if (adminRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(adminRaw);
    } catch {
      problems.push('MINT_ADMIN_API_KEYS_JSON must be a JSON array');
    }
    if (parsed !== undefined && !Array.isArray(parsed)) problems.push('MINT_ADMIN_API_KEYS_JSON must be a JSON array');
    else if (Array.isArray(parsed))
      parsed.forEach((k: unknown, i: number) => {
        const r = k as Record<string, unknown>;
        if (typeof r !== 'object' || r === null) return problems.push(`MINT_ADMIN_API_KEYS_JSON[${i}] must be an object`);
        if ('key' in r) return problems.push(`MINT_ADMIN_API_KEYS_JSON[${i}] contains a plaintext key; configure the SHA-256 hash only`);
        if (typeof r.id !== 'string' || typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash))
          return problems.push(`MINT_ADMIN_API_KEYS_JSON[${i}] needs id and hash (lower-case sha256 hex of the key)`);
        const scopes = Array.isArray(r.scopes) ? r.scopes.filter((x): x is string => typeof x === 'string') : [];
        if (scopes.length === 0 || scopes.some((x) => x !== SCOPE_MINT_ADMIN)) return problems.push(`MINT_ADMIN_API_KEYS_JSON[${i}].scopes must be ["${SCOPE_MINT_ADMIN}"]`);
        const envv = r.env ?? adminApiKeyEnvironment;
        if (envv !== adminApiKeyEnvironment) return problems.push(`MINT_ADMIN_API_KEYS_JSON[${i}].env must be ${adminApiKeyEnvironment} on ${net}`);
        adminApiKeys.push({ id: r.id, hash: r.hash, env: adminApiKeyEnvironment, scopes, ...(typeof r.name === 'string' ? { name: r.name } : {}) });
      });
  }
  const warnings: string[] = [];
  if (!dev && adminApiKeys.length === 0) warnings.push('no MINT_ADMIN_API_KEYS_JSON: a parent value change cannot be acknowledged without a redeploy');

  // Event bus (p5.3): RabbitMQ via @bsh/events connectAmqpBus. Events are how block.space and the studio
  // learn about mints, so mainnet refuses to run without it.
  let bus: MintConfig['bus'] = null;
  const amqpUrl = str('AMQP_URL');
  const amqpExchange = str('AMQP_EXCHANGE') ?? 'bsh.events';
  const amqpConnectTimeoutMs = int('AMQP_CONNECT_TIMEOUT_MS', 10_000, 500, 120_000);
  if (!/^[A-Za-z0-9._-]{1,127}$/.test(amqpExchange)) problems.push('AMQP_EXCHANGE must be an exchange name (letters, digits, ".", "_", "-")');
  if (amqpUrl) {
    let ok = false;
    try {
      const u = new URL(amqpUrl);
      ok = (u.protocol === 'amqp:' || u.protocol === 'amqps:') && !!u.hostname;
    } catch {
      ok = false;
    }
    if (!ok) problems.push('AMQP_URL must be an amqp:// or amqps:// URL');
    else bus = { url: amqpUrl, exchange: amqpExchange, connectTimeoutMs: amqpConnectTimeoutMs };
  } else if (net === 'mainnet') {
    problems.push('AMQP_URL is required on mainnet: events (degent.mint.order.*, collection.minted, royalty.paid) are how block.space and the studio learn about mints');
  } else if (!dev) {
    warnings.push(`AMQP_URL unset on ${net}: events stay in this process; block.space and the studio will not hear about mints`);
  }

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

  const out: MintConfig = {
    settings: {
      network: net,
      version,
      collection: {
        ...structuredClone(DEFAULT_CONFIG),
        network: net,
        parentInscriptionId,
        minFeeRate,
        quoteTtlSeconds,
        rescueAfterSeconds,
        serviceFeeSats: { standard: feeStd, large: feeLarge, fullblock: feeFull },
      } satisfies CollectionConfig,
      collectionAddress: collectionAddress ?? '',
      parentValueSats,
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
      royaltyBps,
      clubFeeBps,
      studioUrl,
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
    remoteSigner,
    parentKeyFile,
    revealEncryptionKey,
    corsOrigins,
    artReviewApiKey: str('ART_REVIEW_API_KEY'),
    artReviewGuidelinesFile: str('ART_REVIEW_GUIDELINES_FILE'),
    workerIntervalMs: int('WORKER_INTERVAL_MS', 15_000, 1_000, 600_000),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60, 1, 100_000),
    trustProxy: str('TRUST_PROXY') === 'true',
    studio: studioUrl ? { url: studioUrl, apiKey: studioApiKey } : null,
    ledger: ledgerUrl ? { url: ledgerUrl, apiKey: ledgerApiKey } : null,
    adminApiKeys,
    adminApiKeyEnvironment,
    bus,
    warnings,
  };
  if (problems.length) throw new ConfigError(problems);
  return out;
}
