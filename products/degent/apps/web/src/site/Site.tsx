/**
 * degent.club: the whole site in one app. Router + global chrome (header with live meters,
 * slide-out nav, social rail, scroll progress, back-to-top, footer with newsletter) around the
 * pages. The mint wizard (`App`) is embedded at /mint and stays mounted once visited, so leaving
 * /mint mid-order never discards its in-memory state (the reveal key vault, the order token).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AppConfig } from '../config';
import type { Services } from '../services/types';
import type { KeyValueStore } from '../lib/recovery';
import { browserStore } from '../lib/recovery';
import type { KeyVault } from '../flow/keyVault';
import { App, type MintHandoff } from '../App';
import { SiteContext, useAsync, useSite, type SiteContextValue } from './context';
import { RouterProvider, browserHistory, useRouter, type HistoryLike, type Route } from './router';
import type { SiteServices } from './services/types';
import { useDocumentMeta } from './lib/meta';
import { Header } from './chrome/Header';
import { Footer, Rail } from './chrome/Footer';
import { Home } from './pages/Home';
import { Collection } from './pages/Collection';
import { Exhibit } from './pages/Exhibit';
import { Atelier } from './pages/Atelier';
import { Comic } from './pages/Comic';
import { CopyPage } from './pages/Copy';
import { HowItWorks } from './pages/HowItWorks';
import { Blog, BlogPost } from './pages/Blog';
import { Club } from './pages/Club';
import { NotFound } from './pages/NotFound';

export interface SiteProps {
  app: AppConfig;
  site: SiteServices;
  mint: Services;
  history?: HistoryLike;
  /** Mint wizard plumbing (tests inject memory store / vault). */
  mintStore?: KeyValueStore | null;
  mintVault?: KeyVault;
  atelierPollMs?: number;
}

export function Site(props: SiteProps) {
  const history = useMemo(() => props.history ?? browserHistory(), [props.history]);
  return (
    <RouterProvider history={history}>
      <Shell {...props} />
    </RouterProvider>
  );
}

/** Pathname without the item number: moving between /collection and /collection/:n is not a page change. */
function pageKey(r: Route): string {
  return r.name === 'collection' || r.name === 'exhibit' ? r.name : r.name === 'post' ? `post:${r.slug}` : r.name;
}

function MintPage({ handoff, store, vault }: { handoff: MintHandoff | null; store: KeyValueStore | null; vault: KeyVault | undefined }) {
  const { app, mint } = useSite();
  useDocumentMeta({ title: 'Mint a Degent', description: 'The non-custodial degent.club mint: what you preview is what lands on chain.' });
  return <App app={app} services={mint} embedded handoff={handoff} store={store} {...(vault ? { vault } : {})} />;
}

function Shell({ app, site, mint, mintStore, mintVault, atelierPollMs }: SiteProps) {
  const { route, navigate } = useRouter();
  const stats = useAsync(() => site.stats.getStats(), [site]);
  const [handoff, setHandoff] = useState<MintHandoff | null>(null);
  const [mintMounted, setMintMounted] = useState(route.name === 'mint');
  const seq = useRef(0);
  const store = useMemo(() => (mintStore === undefined ? browserStore() : mintStore), [mintStore]);

  useEffect(() => {
    if (route.name === 'mint') setMintMounted(true);
  }, [route.name]);

  const sendToMint = useCallback(
    (h: Omit<MintHandoff, 'id'>) => {
      setHandoff({ ...h, id: `h${++seq.current}` });
      setMintMounted(true);
      navigate('/mint');
    },
    [navigate],
  );

  const value = useMemo<SiteContextValue>(() => ({ app, site, mint, handoff, sendToMint }), [app, site, mint, handoff, sendToMint]);

  // Move focus to the new page's heading on navigation (not on first load, not inside the gallery).
  const key = pageKey(route);
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (route.name === 'mint') return; // the mint focuses its own step heading
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#main h1')?.focus({ preventScroll: true }));
  }, [key, route.name]);

  let page: ReactElement | null;
  switch (route.name) {
    case 'home':
      page = <Home stats={stats} />;
      break;
    case 'collection':
      page = <Collection n={route.n} stats={stats} />;
      break;
    case 'exhibit':
      page = <Exhibit n={route.n} />;
      break;
    case 'atelier':
      page = <Atelier {...(atelierPollMs ? { pollMs: atelierPollMs } : {})} />;
      break;
    case 'comic':
      page = <Comic />;
      break;
    case 'manifesto':
    case 'about':
      page = <CopyPage page={route.name} />;
      break;
    case 'how':
      page = <HowItWorks />;
      break;
    case 'blog':
      page = <Blog />;
      break;
    case 'post':
      page = <BlogPost slug={route.slug} />;
      break;
    case 'club':
      page = <Club />;
      break;
    case 'mint':
      page = null;
      break;
    case 'notfound':
      page = <NotFound />;
      break;
  }

  return (
    <SiteContext.Provider value={value}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      {site.mode === 'demo' ? (
        <div className="demo-ribbon" role="note">
          <strong>DEMO</strong> — simulated wallet, mint, chain, Atelier and ord data; stats from the bundled manifest. No bitcoin moves. Remove{' '}
          <code>?demo=1</code> for the real site.
        </div>
      ) : null}
      <Header stats={stats} />
      <Rail />
      <main id="main" className={`site-main site-main--${route.name}`} data-route={route.name}>
        {page}
        {mintMounted ? (
          <div className="container mint-host" hidden={route.name !== 'mint'}>
            <MintPage handoff={handoff} store={store} vault={mintVault} />
          </div>
        ) : null}
      </main>
      <Footer />
    </SiteContext.Provider>
  );
}
