import type { Network } from '@bsh/degent-mint-sdk';

/** Runtime configuration, from Vite env vars with safe defaults. See README "Configuration". */
export interface AppConfig {
  network: Network;
  mintApiUrl: string;
  /** Artist Studio base URL (`/v1/...` is appended). */
  studioApiUrl: string;
  esploraUrl: string;
  explorerUrl: string;
  ordContentUrl: string;
  pollIntervalMs: number;
  /** Artworks per gallery page. */
  galleryPageSize: number;
  /** block.space certification base URL (`/v1/collections/...` is appended). */
  certifyUrl: string;
  /** The collection's slug at block.space. */
  collectionSlug: string;
  /** The comic's inscription id, when known (TODO(copy): not captured from the live site). */
  comicInscriptionId: string | null;
  demo: boolean;
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
  VITE_STUDIO_API_URL?: string;
  VITE_ESPLORA_URL?: string;
  VITE_NETWORK?: string;
  VITE_EXPLORER_URL?: string;
  VITE_ORD_URL?: string;
  VITE_POLL_MS?: string;
  VITE_GALLERY_PAGE_SIZE?: string;
  VITE_CERTIFY_URL?: string;
  VITE_COLLECTION_SLUG?: string;
  VITE_COMIC_INSCRIPTION_ID?: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INSCRIPTION_ID = /^[0-9a-f]{64}i[0-9]+$/;

export function readConfig(env: EnvLike, search: string): AppConfig {
  const params = new URLSearchParams(search);
  const demo = params.get('demo') === '1' || params.get('demo') === 'true';
  const rawNet = (env.VITE_NETWORK ?? 'mainnet') as Network;
  const network: Network = NETWORKS.includes(rawNet) ? rawNet : 'mainnet';
  const poll = Number(env.VITE_POLL_MS ?? '');
  const pageSize = Number(env.VITE_GALLERY_PAGE_SIZE ?? '');
  return {
    network,
    mintApiUrl: trimSlash(env.VITE_MINT_API_URL ?? '/api'),
    studioApiUrl: trimSlash(env.VITE_STUDIO_API_URL ?? '/studio'),
    esploraUrl: trimSlash(env.VITE_ESPLORA_URL ?? defaultEsplora(network)),
    explorerUrl: trimSlash(env.VITE_EXPLORER_URL ?? 'https://explore.block.space'),
    ordContentUrl: trimSlash(env.VITE_ORD_URL ?? 'https://ordinals.com'),
    pollIntervalMs: Number.isFinite(poll) && poll > 0 ? poll : demo ? 1200 : 5000,
    galleryPageSize: Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100 ? pageSize : 12,
    certifyUrl: trimSlash(env.VITE_CERTIFY_URL ?? 'https://certify.block.space'),
    collectionSlug: env.VITE_COLLECTION_SLUG && SLUG.test(env.VITE_COLLECTION_SLUG) ? env.VITE_COLLECTION_SLUG : 'degents',
    comicInscriptionId: env.VITE_COMIC_INSCRIPTION_ID && INSCRIPTION_ID.test(env.VITE_COMIC_INSCRIPTION_ID) ? env.VITE_COMIC_INSCRIPTION_ID : null,
    demo,
  };
}
