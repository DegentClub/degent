import type { Network } from '@bsh/degent-mint-sdk';

/** Runtime configuration, from Vite env vars with safe defaults. See README "Configuration". */
export interface AppConfig {
  network: Network;
  mintApiUrl: string;
  esploraUrl: string;
  explorerUrl: string;
  ordContentUrl: string;
  pollIntervalMs: number;
  demo: boolean;
  /** block.space certification API base (`GET /v1/collections/degents`). Empty = not configured. */
  certifyUrl: string;
  /** Atelier service base (`contracts/openapi/degent-atelier.yaml`). Empty = not configured. */
  atelierUrl: string;
  /** Newsletter subscription endpoint (POST JSON { name, email }). Empty = not configured. */
  newsletterUrl: string;
  /** Inscription id of the on-chain comic. Empty = placeholder. */
  comicInscriptionId: string;
  /** Pages whose final copy has shipped (`VITE_COPY_READY=manifesto,about`); others are TODO(copy). */
  copyReady: ReadonlySet<CopyPage>;
  /** Magic Eden collection page (the Buy button). */
  marketplaceUrl: string;
  social: { x: string; telegram: string; instagram: string };
  /** Collection slug used on block.space and Magic Eden. */
  collectionSlug: string;
}

export type CopyPage = 'manifesto' | 'about';

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
  VITE_CERTIFY_URL?: string;
  VITE_ATELIER_URL?: string;
  VITE_NEWSLETTER_URL?: string;
  VITE_COMIC_INSCRIPTION_ID?: string;
  VITE_COPY_READY?: string;
  VITE_MARKETPLACE_URL?: string;
  VITE_X_URL?: string;
  VITE_TELEGRAM_URL?: string;
  VITE_INSTAGRAM_URL?: string;
  /** `1`: demo mode unless the URL says `?demo=0` (the static GitHub Pages build has no server behind it). */
  VITE_DEMO_DEFAULT?: string;
}

const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/;

function parseCopyReady(v: string | undefined): Set<CopyPage> {
  const out = new Set<CopyPage>();
  for (const part of (v ?? '').split(',')) {
    const p = part.trim().toLowerCase();
    if (p === 'manifesto' || p === 'about') out.add(p);
  }
  return out;
}

const TRUE = new Set(['1', 'true']);
const FALSE = new Set(['0', 'false']);

/** `?demo=1|true` forces demo, `?demo=0|false` forces live, otherwise `VITE_DEMO_DEFAULT` decides (default: live). */
export function demoFlag(param: string | null, envDefault: string | undefined): boolean {
  if (param !== null && TRUE.has(param)) return true;
  if (param !== null && FALSE.has(param)) return false;
  return TRUE.has((envDefault ?? '').trim().toLowerCase());
}

export function readConfig(env: EnvLike, search: string): AppConfig {
  const params = new URLSearchParams(search);
  const demo = demoFlag(params.get('demo'), env.VITE_DEMO_DEFAULT);
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
    certifyUrl: trimSlash(env.VITE_CERTIFY_URL ?? ''),
    atelierUrl: trimSlash(env.VITE_ATELIER_URL ?? ''),
    newsletterUrl: (env.VITE_NEWSLETTER_URL ?? '').trim(),
    comicInscriptionId: INSCRIPTION_ID.test(env.VITE_COMIC_INSCRIPTION_ID ?? '') ? env.VITE_COMIC_INSCRIPTION_ID! : '',
    copyReady: parseCopyReady(env.VITE_COPY_READY),
    marketplaceUrl: env.VITE_MARKETPLACE_URL ?? 'https://magiceden.io/ordinals/marketplace/degentclub',
    social: {
      x: env.VITE_X_URL ?? 'https://x.com/degentclub',
      telegram: env.VITE_TELEGRAM_URL ?? 'https://t.me/+cneroYQ-0VpmM2Ix',
      // No verified handle in the spec capture: shown only when configured.
      instagram: env.VITE_INSTAGRAM_URL ?? '',
    },
    collectionSlug: 'degents',
  };
}
