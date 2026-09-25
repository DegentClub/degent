import { render } from '@testing-library/react';
import { tierForSize, type Tier } from '@bsh/degent-mint-sdk';
import type { AppConfig } from '../src/config';
import { App } from '../src/App';
import { createKeyVault, type KeyVault } from '../src/flow/keyVault';
import { openOrder } from '../src/flow/effects';
import { flowReducer } from '../src/flow/reducer';
import { initialState, type Artwork, type FlowState } from '../src/flow/state';
import type { KeyValueStore } from '../src/lib/recovery';
import { createFakeServices, type FakeServices, type FakeServicesOptions } from '../src/services/fakes';
import type { Services } from '../src/services/types';

export function testApp(over: Partial<AppConfig> = {}): AppConfig {
  return {
    network: 'mainnet',
    mintApiUrl: 'http://mint.test',
    studioApiUrl: 'http://studio.test',
    esploraUrl: 'http://esplora.test',
    explorerUrl: 'https://explore.block.space',
    ordContentUrl: 'https://ord.test',
    pollIntervalMs: 10,
    galleryPageSize: 12,
    certifyUrl: 'https://certify.test',
    collectionSlug: 'degents',
    comicInscriptionId: null,
    demo: true,
    ...over,
  };
}

export function memoryStore(log?: string[]): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      log?.push('store.setItem');
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
  };
}

export function fakes(o: FakeServicesOptions = {}): FakeServices {
  return createFakeServices({ images: { fullSize: 1_400_000, width: 1600, height: 1600 }, ...o });
}

/** Exact bytes of a fake WebP that lands in the Standard range. */
export async function standardArtwork(services: Services): Promise<Artwork> {
  return artworkAtQuality(services, 0.2);
}

export async function artworkAtQuality(services: Services, quality: number): Promise<Artwork> {
  const src = await services.images.decode(new Blob([]));
  const enc = await services.images.encode(src, { type: 'image/webp', quality, scale: 1 });
  const bytes = new Uint8Array(await enc.blob.arrayBuffer());
  return {
    fileName: 'gent.webp',
    bytes,
    contentType: 'image/webp',
    size: bytes.length,
    width: enc.width,
    height: enc.height,
    sha256: services.inscription.sha256Hex(bytes),
    origin: 'reencoded',
    quality,
    scale: 1,
  };
}

/** Artwork of (about) `size` bytes from the default fake encoder (fullSize 1,400,000: size = fullSize * (0.08 + 0.92q)). */
export async function artworkOfSize(services: Services, size: number, fullSize = 1_400_000): Promise<Artwork> {
  const q = (size / fullSize - 0.08) / 0.92;
  const art = await artworkAtQuality(services, q);
  // fakeEncodedSize rounds; the caller asserts the exact size it needs.
  return art;
}

/** Drive the flow (without UI) to an approved order sitting on the Quote step. */
export async function stateAtQuote(
  services: FakeServices,
  app: AppConfig,
  vault: KeyVault = createKeyVault(),
  tier: Tier = 'standard',
  artworkOverride?: Artwork,
): Promise<{ state: FlowState; vault: KeyVault }> {
  let s = initialState();
  const config = await services.mintApi.getConfig();
  s = flowReducer(s, { type: 'CONFIG_LOADED', config });
  s = flowReducer(s, { type: 'SNAPSHOT_LOADED', fees: await services.mintApi.getFees(), queue: await services.mintApi.getQueue() });
  const wallet = await services.wallets.connect('unisat', app.network);
  s = flowReducer(s, { type: 'WALLET_CONNECTED', wallet });
  s = flowReducer(s, { type: 'TIER_SELECTED', tier });
  const artwork = artworkOverride ?? (await standardArtwork(services));
  s = flowReducer(s, { type: 'ARTWORK_READY', artwork });
  const order = await openOrder(
    { services, vault, sleep: async () => undefined },
    { tier, artwork, wallet, feeRate: 4 },
  );
  s = flowReducer(s, { type: 'ORDER_UPDATED', order });
  s = { ...s, step: 'quote' };
  return { state: s, vault };
}

export function renderApp(
  services: Services,
  opts: { app?: AppConfig; store?: KeyValueStore; sessionStore?: KeyValueStore; vault?: KeyVault; initial?: FlowState; hash?: string } = {},
) {
  const store = opts.store ?? memoryStore();
  const sessionStore = opts.sessionStore ?? memoryStore();
  const vault = opts.vault ?? createKeyVault();
  const app = opts.app ?? testApp();
  // `#/` is the Home page since the site rebuild (p6.1); the mint wizard lives at `#/mint`, which is where
  // most tests start. Pass `hash: '#/'` for Home.
  window.location.hash = opts.hash ?? '#/mint';
  const utils = render(
    <App app={app} services={services} store={store} sessionStore={sessionStore} vault={vault} {...(opts.initial ? { initial: opts.initial } : {})} />,
  );
  return { ...utils, store, sessionStore, vault, app };
}

/** Sign in to the fake studio through the API (challenge → wallet.signMessage → verify); returns the session token. */
export async function apiSignIn(services: Services, wallet: { ordinals: { address: string }; signMessage?: (m: string, a: string, t?: 'bip322-simple' | 'ecdsa') => Promise<string> }): Promise<{ token: string; address: string }> {
  const address = wallet.ordinals.address;
  const ch = await services.studio.challenge(address, 'mainnet');
  const signature = await wallet.signMessage!(ch.message, address, 'bip322-simple');
  const s = await services.studio.verify({ message: ch.message, signature, address });
  return { token: s.token, address };
}

/** The exact bytes of a studio artwork as the mint wizard would hold them. */
export async function studioArtworkBytes(services: Services, artworkId: string): Promise<Artwork> {
  const c = await services.studio.getContent(artworkId);
  return {
    fileName: `${artworkId}.png`,
    bytes: c.bytes,
    contentType: c.contentType,
    size: c.bytes.length,
    width: 500,
    height: 500,
    sha256: services.inscription.sha256Hex(c.bytes),
    origin: 'original',
  };
}

/** Drive the flow (without UI) to an approved order for a studio artwork, sitting on the Quote step. */
export async function stateAtQuoteForArtwork(
  services: FakeServices,
  app: AppConfig,
  artworkId: string,
  vault: KeyVault = createKeyVault(),
): Promise<{ state: FlowState; vault: KeyVault }> {
  let s = initialState();
  const config = await services.mintApi.getConfig();
  s = flowReducer(s, { type: 'CONFIG_LOADED', config });
  s = flowReducer(s, { type: 'SNAPSHOT_LOADED', fees: await services.mintApi.getFees(), queue: await services.mintApi.getQueue() });
  const wallet = await services.wallets.connect('unisat', app.network);
  s = flowReducer(s, { type: 'WALLET_CONNECTED', wallet });
  const studioArtwork = await services.studio.getArtwork(artworkId);
  s = flowReducer(s, { type: 'STUDIO_ARTWORK_SELECTED', artwork: studioArtwork });
  const artwork = await studioArtworkBytes(services, artworkId);
  const tier = tierForSize(artwork.size, config)!.tier;
  s = flowReducer(s, { type: 'TIER_SELECTED', tier });
  s = flowReducer(s, { type: 'ARTWORK_READY', artwork });
  const order = await openOrder({ services, vault, sleep: async () => undefined }, { tier, artwork, wallet, feeRate: 4, artworkId });
  s = flowReducer(s, { type: 'ORDER_UPDATED', order });
  s = { ...s, step: 'quote' };
  return { state: s, vault };
}
