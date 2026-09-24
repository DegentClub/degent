import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { AppConfig } from './config';
import type { Services } from './services/types';
import { MintContext, type MintContextValue } from './flow/context';
import { StudioProvider } from './flow/studio';
import { flowReducer } from './flow/reducer';
import { initialState, type FlowState } from './flow/state';
import { createKeyVault, type KeyVault } from './flow/keyVault';
import { browserStore, loadRecovery, type KeyValueStore } from './lib/recovery';
import { browserSessionStore } from './lib/studioSession';
import { isMintRoute, useRoute } from './lib/router';
import { errorText } from './components/ui';
import { Header } from './components/Header';
import { Link } from './components/Link';
import { ProgressNav } from './components/ProgressNav';
import { Welcome } from './screens/Welcome';
import { Connect } from './screens/Connect';
import { Create } from './screens/Create';
import { Validate } from './screens/Validate';
import { QuoteScreen } from './screens/Quote';
import { Pay } from './screens/Pay';
import { Track } from './screens/Track';
import { Gallery } from './screens/Gallery';
import { ArtworkPage } from './screens/Artwork';
import { Studio } from './screens/Studio';
import { StudioUpload } from './screens/StudioUpload';
import { StudioRoyalties } from './screens/StudioRoyalties';

export interface AppProps {
  app: AppConfig;
  services: Services;
  store?: KeyValueStore | null;
  /** Per-tab store for the studio session (sessionStorage by default). */
  sessionStore?: KeyValueStore | null;
  vault?: KeyVault;
  /** Start somewhere other than the welcome screen (tests). */
  initial?: FlowState;
}

export function App({ app, services, store = browserStore(), sessionStore = browserSessionStore(), vault: vaultProp, initial }: AppProps) {
  const vaultRef = useRef<KeyVault>(vaultProp ?? createKeyVault());
  const [state, dispatch] = useReducer(flowReducer, store, (s) => initial ?? initialState(loadRecovery(s)));
  const mainRef = useRef<HTMLElement>(null);
  const route = useRoute();

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

  // `#/mint/:artworkId` (from the gallery, or a shared link): prefill the wizard with that studio Degent.
  const wantedArtwork = route.name === 'mint' ? route.artworkId : null;
  const haveArtwork = state.studioArtwork?.id ?? null;
  useEffect(() => {
    if (!wantedArtwork || wantedArtwork === haveArtwork) return;
    let alive = true;
    services.studio
      .getArtwork(wantedArtwork)
      .then((artwork) => alive && dispatch({ type: 'STUDIO_ARTWORK_SELECTED', artwork }))
      .catch((e) => alive && dispatch({ type: 'ERROR', error: `Could not load artwork ${wantedArtwork}: ${errorText(e)}` }));
    return () => {
      alive = false;
    };
  }, [wantedArtwork, haveArtwork, services]);

  // Move focus to the new step's / page's heading for keyboard and screen-reader users.
  const firstRender = useRef(true);
  const routeKey = route.name === 'artwork' ? `artwork:${route.id}` : route.name;
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const h = mainRef.current?.querySelector<HTMLElement>('h1');
    h?.focus();
  }, [state.step, routeKey]);

  const ctx: MintContextValue = useMemo(
    () => ({ app, services, vault: vaultRef.current, store, sessionStore, state, dispatch }),
    [app, services, store, sessionStore, state],
  );

  const mint = isMintRoute(route);

  return (
    <MintContext.Provider value={ctx}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      {services.mode === 'demo' ? (
        <div className="demo-ribbon" role="note">
          <strong>DEMO</strong> — simulated wallet, server and chain. No bitcoin moves. Remove <code>?demo=1</code> for
          the real mint.
        </div>
      ) : null}
      <Header />
      {mint ? <ProgressNav /> : null}
      <main id="main" ref={mainRef} className="main">
        {state.error ? (
          <div className="alert alert--bad" role="alert">
            <p className="alert__title">Something needs your attention</p>
            <div className="alert__body">{state.error}</div>
          </div>
        ) : null}
        {mint && state.step === 'welcome' && <Welcome />}
        {mint && state.step === 'connect' && <Connect />}
        {mint && state.step === 'create' && <Create />}
        {mint && state.step === 'validate' && <Validate />}
        {mint && state.step === 'quote' && <QuoteScreen />}
        {mint && state.step === 'pay' && <Pay />}
        {mint && state.step === 'track' && <Track />}
        {route.name === 'gallery' && <Gallery page={route.page} artist={route.artist} />}
        {route.name === 'artwork' && <ArtworkPage id={route.id} />}
        {route.name === 'studio' && (
          <StudioProvider>
            <Studio />
          </StudioProvider>
        )}
        {route.name === 'studio-upload' && (
          <StudioProvider>
            <StudioUpload />
          </StudioProvider>
        )}
        {route.name === 'studio-royalties' && (
          <StudioProvider>
            <StudioRoyalties />
          </StudioProvider>
        )}
        {route.name === 'not-found' && (
          <div className="screen">
            <div className="screen-heading">
              <p className="kicker">404</p>
              <h1 tabIndex={-1}>No such room in the club.</h1>
              <p className="lede">
                <code className="mono">{route.path}</code> is not a page here. Try the <Link to={{ name: 'gallery', page: 1, artist: null }}>gallery</Link>, the{' '}
                <Link to={{ name: 'mint', artworkId: null }}>mint</Link> or the <Link to={{ name: 'studio' }}>studio</Link>.
              </p>
            </div>
          </div>
        )}
      </main>
      <footer className="footer">
        <p>
          The Decentralized Gentlemen Club · non-custodial by design: your one-time reveal key stays with you (in your
          recovery bundle, never on our server), the server only ever holds a half-signed transaction that pays{' '}
          <em>you</em>, and artists are paid by minters directly, in the funding transaction.
        </p>
        <p className="muted small">
          Network: <span className="mono">{app.network}</span>
          {services.mode === 'demo' ? ' · demo mode' : ''}
        </p>
      </footer>
    </MintContext.Provider>
  );
}
