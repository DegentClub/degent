import type { MintMode, Network } from '@bsh/degent-mint-sdk';

/** Runtime configuration, from Vite env vars with safe defaults. See README "Configuration". */
export interface AppConfig {
  network: Network;
  mintApiUrl: string;
  esploraUrl: string;
  explorerUrl: string;
  ordContentUrl: string;
  pollIntervalMs: number;
  demo: boolean;
  /** Base URL of the Telegram gate service (VITE_GATE_URL; the page calls /gate/challenge and /gate/verify). Empty = gate disabled. */
  gateUrl: string;
  /** Public site origin used in share links (VITE_SITE_URL), defaults to the current origin. */
  siteUrl: string;
  /** Collection page on the marketplace, for "Buy" until first-party trading ships (VITE_BUY_URL). */
  buyUrl: string;
  /** Per-item marketplace link; `{id}` is replaced by the inscription id (VITE_BUY_ITEM_URL). */
  buyItemUrl: string;
  /** The comic inscription (VITE_COMIC_INSCRIPTION_ID); empty = /comic shows a placeholder. */
  comicInscriptionId: string;
  /** Optional page-by-page comic: inscription ids, comma-separated (VITE_COMIC_PAGES). */
  comicPages: string[];
  /** Socials (VITE_X_URL, VITE_TELEGRAM_URL, VITE_INSTAGRAM_URL); empty hides the link. */
  socials: { x: string; telegram: string; instagram: string };
  /**
   * Build-time hint for the mint mode (VITE_MINT_MODE, default `full`), used until `/v1/config` answers; the
   * runtime `mode` from the API always wins, so one build serves a read-only and a full mint.
   */
  mintMode: MintMode;
  /** Where "Minting opens soon" sends people while the mint is read-only: the signet beta (VITE_BETA_URL); empty = /mint explainer. */
  betaUrl: string;
}

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export function defaultEsplora(network: Network): string {
  switch (network) {
    case 'mainnet':
      return 'https://mempool.space/api';
    case 'testnet':
      return 'https://mempool.space/testnet4/api';
    case 'signet':
      return 'https://mempool.space/signet/api';
    case 'regtest':
      return 'http://localhost:3002';
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface EnvLike {
  VITE_MINT_API_URL?: string;
  VITE_ESPLORA_URL?: string;
  VITE_NETWORK?: string;
  VITE_EXPLORER_URL?: string;
  VITE_ORD_URL?: string;
  VITE_POLL_MS?: string;
  VITE_GATE_URL?: string;
  VITE_SITE_URL?: string;
  VITE_BUY_URL?: string;
  VITE_BUY_ITEM_URL?: string;
  VITE_COMIC_INSCRIPTION_ID?: string;
  VITE_COMIC_PAGES?: string;
  VITE_X_URL?: string;
  VITE_TELEGRAM_URL?: string;
  VITE_INSTAGRAM_URL?: string;
  VITE_MINT_MODE?: string;
  VITE_BETA_URL?: string;
}

const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/;

/** Only absolute https URLs (or http on localhost) become outbound links. */
export function safeHttpUrl(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return trimSlash(v);
  } catch {
    /* not a URL */
  }
  return '';
}

/** Only well-formed inscription ids reach an ord URL. */
function inscriptionIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => INSCRIPTION_ID.test(x));
}

export function readConfig(env: EnvLike, search: string): AppConfig {
  const params = new URLSearchParams(search);
  const demo = params.get('demo') === '1' || params.get('demo') === 'true';
  const rawNet = (env.VITE_NETWORK ?? 'mainnet') as Network;
  const network: Network = NETWORKS.includes(rawNet) ? rawNet : 'mainnet';
  const poll = Number(env.VITE_POLL_MS ?? '');
  return {
    network,
    mintApiUrl: trimSlash(env.VITE_MINT_API_URL ?? '/api'),
    esploraUrl: trimSlash(env.VITE_ESPLORA_URL ?? defaultEsplora(network)),
    explorerUrl: trimSlash(env.VITE_EXPLORER_URL ?? 'https://explore.block.space'),
    ordContentUrl: trimSlash(env.VITE_ORD_URL ?? 'https://ordinals.com'),
    pollIntervalMs: Number.isFinite(poll) && poll > 0 ? poll : demo ? 1200 : 5000,
    demo,
    gateUrl: trimSlash(env.VITE_GATE_URL ?? ''),
    siteUrl: trimSlash(env.VITE_SITE_URL ?? 'https://degent.club'),
    buyUrl: env.VITE_BUY_URL ?? 'https://magiceden.io/ordinals/marketplace/degentclub',
    buyItemUrl: env.VITE_BUY_ITEM_URL ?? 'https://magiceden.io/ordinals/item-details/{id}',
    comicInscriptionId: inscriptionIds(env.VITE_COMIC_INSCRIPTION_ID)[0] ?? '',
    comicPages: inscriptionIds(env.VITE_COMIC_PAGES),
    socials: {
      x: env.VITE_X_URL ?? 'https://x.com/degentclub',
      telegram: env.VITE_TELEGRAM_URL ?? 'https://t.me/+cneroYQ-0VpmM2Ix',
      instagram: env.VITE_INSTAGRAM_URL ?? '',
    },
    mintMode: env.VITE_MINT_MODE === 'readonly' ? 'readonly' : 'full',
    betaUrl: safeHttpUrl(env.VITE_BETA_URL),
  };
}
