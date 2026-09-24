import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { AppConfig } from './config';
import type { Services } from './services/types';
import { MintContext, type MintContextValue } from './flow/context';
import { flowReducer } from './flow/reducer';
import { initialState, type FlowState } from './flow/state';
import { createKeyVault, type KeyVault } from './flow/keyVault';
import { browserStore, loadRecovery, type KeyValueStore } from './lib/recovery';
import { errorText } from './components/ui';
import { ProgressNav } from './components/ProgressNav';
import { Welcome } from './screens/Welcome';
import { Connect } from './screens/Connect';
import { Create } from './screens/Create';
import { Validate } from './screens/Validate';
import { QuoteScreen } from './screens/Quote';
import { Pay } from './screens/Pay';
import { Track } from './screens/Track';
import { Review } from './screens/Review';
import { Explorer } from './screens/Explorer';
import { Verify } from './screens/Verify';
import { matchRoute, navigate, usePathname } from './router';
import { SiteDataProvider } from './site/data';
import { SiteFooter, SiteHeader, SocialRail } from './site/chrome';
import { Home } from './pages/Home';
import { Collection } from './pages/Collection';
import { DegentPage } from './pages/DegentPage';
import { Comic } from './pages/Comic';
import { HowItWorks } from './pages/HowItWorks';
import { Club } from './pages/Club';
import { About, Manifesto, NotFound } from './pages/TodoCopy';

export interface AppProps {
  app: AppConfig;
  services: Services;
  store?: KeyValueStore | null;
  vault?: KeyVault;
  /** Start somewhere other than the welcome screen (tests). */
  initial?: FlowState;
  /** Pin the route (tests); defaults to window.location.pathname. */
  path?: string;
  /** Query string for the /verify page (tests); defaults to window.location.search. */
  search?: string;
}

export function App({ app, services, store = browserStore(), vault: vaultProp, initial, path, search }: AppProps) {
  const match = matchRoute(usePathname(path));
  const route = match.route;
  const vaultRef = useRef<KeyVault>(vaultProp ?? createKeyVault());
  const [state, dispatch] = useReducer(flowReducer, store, (s) => initial ?? initialState(loadRecovery(s)));
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    services.mintApi
      .getConfig()
      .then((config) => alive && dispatch({ type: 'CONFIG_LOADED', config }))
      .catch((e) => alive && dispatch({ type: 'ERROR', error: `Could not load the collection rules: ${errorText(e)}` }));
    Promise.allSettled([services.mintApi.getFees(), services.mintApi.getQueue()]).then(([f, q]) => {
      if (!alive) return;
      dispatch({
        type: 'SNAPSHOT_LOADED',
        fees: f.status === 'fulfilled' ? f.value : null,
        queue: q.status === 'fulfilled' ? q.value : null,
      });
    });
    const vault = vaultRef.current;
    return () => {
      alive = false;
      vault.discardAll();
    };
  }, [services]);

  // Move focus to the new step's or page's heading for keyboard and screen-reader users.
  const firstRender = useRef(true);
  const where = `${route}|${match.n ?? ''}|${match.id ?? ''}|${state.step}`;
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const h = mainRef.current?.querySelector<HTMLElement>('h1');
    h?.focus();
  }, [where]);

  // /track/:id on the device that paid: pick the recovery bundle up automatically.
  const trackId = route === 'track' ? match.id : undefined;
  useEffect(() => {
    if (trackId && state.resumeOffer?.orderId === trackId) dispatch({ type: 'RESUME', bundle: state.resumeOffer });
  }, [trackId, state.resumeOffer]);

  const ctx: MintContextValue = useMemo(
    () => ({ app, services, vault: vaultRef.current, store, state, dispatch }),
    [app, services, store, state],
  );

  const mintScreens = (
    <>
      {state.error ? (
        <div className="alert alert--bad" role="alert">
          <p className="alert__title">Something needs your attention</p>
          <div className="alert__body">{state.error}</div>
        </div>
      ) : null}
      {state.step === 'welcome' && <Welcome />}
      {state.step === 'connect' && <Connect />}
      {state.step === 'create' && <Create />}
      {state.step === 'validate' && <Validate />}
      {state.step === 'quote' && <QuoteScreen />}
      {state.step === 'pay' && <Pay />}
      {state.step === 'track' && <Track />}
    </>
  );

  return (
    <MintContext.Provider value={ctx}>
      <SiteDataProvider services={services}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {services.mode === 'demo' ? (
          <div className="demo-ribbon" role="note">
            <strong>DEMO</strong> — simulated wallet, server and chain. No bitcoin moves. Remove <code>?demo=1</code> for
            the real mint.
          </div>
        ) : null}
        <SiteHeader route={route} />
        {route === 'mint' ? <ProgressNav /> : null}
        <main id="main" ref={mainRef} className={`main main--${route}`}>
          {route === 'home' && <Home />}
          {route === 'collection' && <Collection />}
          {route === 'degent' && match.n !== undefined && <DegentPage n={match.n} />}
          {route === 'comic' && <Comic />}
          {route === 'how' && <HowItWorks />}
          {route === 'club' && <Club />}
          {route === 'manifesto' && <Manifesto />}
          {route === 'about' && <About />}
          {route === 'notfound' && <NotFound />}
          {route === 'review' && <Review />}
          {route === 'explorer' && <Explorer />}
          {route === 'verify' && <Verify {...(search !== undefined ? { search } : {})} />}
          {route === 'track' && match.id !== undefined && <Track orderId={match.id} onDone={() => navigate('/mint')} />}
          {route === 'mint' && mintScreens}
        </main>
        <SocialRail />
        <SiteFooter />
      </SiteDataProvider>
    </MintContext.Provider>
  );
}
