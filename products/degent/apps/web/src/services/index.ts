import type { AppConfig } from '../config';
import type { Services } from './types';
import { createRealMintApi } from './real/mintApi';
import { createRealWallets } from './real/wallet';
import { createRealInscription } from './real/inscription';
import { createEsploraChain } from './real/chain';
import { createCanvasImages } from './real/images';
import { createRealGate } from './real/gate';
import { createFakeServices } from './fakes';

/** Live services talk to the mint API, the wallet extension and esplora. */
export function createLiveServices(app: AppConfig): Services {
  return {
    mode: 'live',
    mintApi: createRealMintApi(app.mintApiUrl),
    wallets: createRealWallets(),
    chain: createEsploraChain(app.esploraUrl, app.ordContentUrl),
    inscription: createRealInscription(),
    images: createCanvasImages(),
    gate: createRealGate(),
  };
}

/** `?demo=1`: fakes for everything with money or a server behind it; real canvas for images. */
export function createDemoServices(app: AppConfig): Services {
  return createFakeServices({ network: app.network, images: createCanvasImages(), wallet: { withPushTx: false }, mint: { seedReview: 3 } });
}

export function createServices(app: AppConfig): Services {
  return app.demo ? createDemoServices(app) : createLiveServices(app);
}

export type { Services } from './types';
