import type { AppConfig } from '../../config';
import type { SiteServices } from './types';
import { createCertifiedCollection, createCertifiedStats } from './real/certify';
import { createOrdService } from './real/ord';
import { createHttpNewsletter } from './real/newsletter';
import { createHttpAtelier } from './real/atelier';
import { createFakeSiteServices } from './fakes';
import { paintDemoDegent } from './demoPainter';

/** Live: block.space certification, ord, the newsletter endpoint and the Atelier, each from its env var. */
export function createLiveSiteServices(app: AppConfig): SiteServices {
  const certify = { baseUrl: app.certifyUrl, slug: app.collectionSlug };
  return {
    mode: 'live',
    stats: createCertifiedStats(certify),
    collection: createCertifiedCollection(certify),
    ord: createOrdService({ baseUrl: app.ordContentUrl }),
    newsletter: createHttpNewsletter({ url: app.newsletterUrl }),
    atelier: createHttpAtelier({ baseUrl: app.atelierUrl }),
  };
}

/** `?demo=1`: bundled manifest for stats and membership, fake ord / newsletter / Atelier (canvas compositor). */
export function createDemoSiteServices(): SiteServices {
  return createFakeSiteServices({ atelier: { render: paintDemoDegent, delayMs: 250, pollsUntilDone: 3 }, ord: { delayMs: 300 }, newsletter: { delayMs: 300 } });
}

export function createSiteServices(app: AppConfig): SiteServices {
  return app.demo ? createDemoSiteServices() : createLiveSiteServices(app);
}
