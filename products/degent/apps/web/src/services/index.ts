import type { AppConfig } from '../config';
import type { Services } from './types';
import { createRealMintApi } from './real/mintApi';
import { createRealWallets } from './real/wallet';
import { createRealInscription } from './real/inscription';
import { createEsploraChain } from './real/chain';
import { createCanvasImages } from './real/images';
import { createStudioApi } from './studioApi';
import { createCertifyApi } from './certifyApi';
import { createOrdApi } from './ordApi';
import { createFakeServices } from './fakes';

/** Live services talk to the mint API, the wallet extension and esplora. */
export function createLiveServices(app: AppConfig): Services {
  return {
    mode: 'live',
    mintApi: createRealMintApi(app.mintApiUrl),
    studio: createStudioApi({ baseUrl: app.studioApiUrl }),
    certify: createCertifyApi({ baseUrl: app.certifyUrl }),
    ord: createOrdApi({ baseUrl: app.ordContentUrl, network: app.network }),
    wallets: createRealWallets(),
    chain: createEsploraChain(app.esploraUrl, app.ordContentUrl),
    inscription: createRealInscription(),
    images: createCanvasImages(),
  };
}

/** `?demo=1`: fakes for everything with money or a server behind it; real canvas for images. */
export function createDemoServices(app: AppConfig): Services {
  return createFakeServices({ network: app.network, images: createCanvasImages(), wallet: { withPushTx: false }, site: { slug: app.collectionSlug } });
}

export function createServices(app: AppConfig): Services {
  return app.demo ? createDemoServices(app) : createLiveServices(app);
}

export type { Services } from './types';
