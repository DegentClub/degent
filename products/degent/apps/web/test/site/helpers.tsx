import { render } from '@testing-library/react';
import type { AppConfig } from '../../src/config';
import { Site } from '../../src/site/Site';
import { memoryHistory } from '../../src/site/router';
import { createFakeSiteServices, fakeItems, type FakeSiteOptions } from '../../src/site/services/fakes';
import type { SiteServices } from '../../src/site/services/types';
import type { FakeServices, FakeServicesOptions } from '../../src/services/fakes';
import { fakes, memoryStore, testApp } from '../helpers';

export const ITEMS = fakeItems(45);

export interface RenderSiteOptions {
  app?: Partial<AppConfig>;
  site?: FakeSiteOptions;
  siteServices?: SiteServices;
  mint?: FakeServicesOptions;
  mintServices?: FakeServices;
}

export function renderSite(path = '/', o: RenderSiteOptions = {}) {
  const history = memoryHistory(path);
  const app = testApp(o.app);
  const site = o.siteServices ?? createFakeSiteServices({ items: ITEMS, ...o.site });
  const mint = o.mintServices ?? fakes(o.mint);
  const utils = render(<Site app={app} site={site} mint={mint} history={history} mintStore={memoryStore()} atelierPollMs={5} />);
  return { ...utils, history, site, mint, app, path: () => history.location.pathname };
}
