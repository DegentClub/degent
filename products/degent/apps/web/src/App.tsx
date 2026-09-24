import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { AppConfig } from './config';
import type { Services } from './services/types';
import { MintContext, type MintContextValue } from './flow/context';
import { flowReducer } from './flow/reducer';
import { initialState, type Artwork, type FlowState, type HandoffInfo } from './flow/state';
import type { Tier } from '@bsh/degent-mint-sdk';
import { createKeyVault, type KeyVault } from './flow/keyVault';
import { browserStore, loadRecovery, type KeyValueStore } from './lib/recovery';
import { errorText } from './components/ui';
import { Header } from './components/Header';
import { ProgressNav } from './components/ProgressNav';
import { Welcome } from './screens/Welcome';
import { Connect } from './screens/Connect';
import { Create } from './screens/Create';
import { Validate } from './screens/Validate';
import { QuoteScreen } from './screens/Quote';
import { Pay } from './screens/Pay';
import { Track } from './screens/Track';

export interface AppProps {
  app: AppConfig;
  services: Services;
  store?: KeyValueStore | null;
  vault?: KeyVault;
  /** Start somewhere other than the welcome screen (tests). */
  initial?: FlowState;
  /**
   * Rendered inside the degent.club site (`/mint`): the site owns the skip link, demo ribbon,
   * header and footer; the mint keeps only its own bar, progress nav and screens.
   */
  embedded?: boolean;
  /** Exact bytes handed over by the Atelier / upload path. A new `id` is dispatched once. */
  handoff?: MintHandoff | null;
}

export interface MintHandoff {
  id: string;
  artwork: Artwork;
  tier: Tier;
  info: HandoffInfo;
}

export function App({ app, services, store = browserStore(), vault: vaultProp, initial, embedded = false, handoff = null }: AppProps) {
  const vaultRef = useRef<KeyVault>(vaultProp ?? createKeyVault());
  const [state, dispatch] = useReducer(flowReducer, store, (s) => initial ?? initialState(loadRecovery(s)));
  const mainRef = useRef<HTMLDivElement>(null);

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

  // Art handed over from the Atelier / upload path lands on Validate (the reducer refuses it once money may have moved).
  const lastHandoff = useRef<string | null>(null);
  useEffect(() => {
    if (!handoff || lastHandoff.current === handoff.id) return;
    lastHandoff.current = handoff.id;
    dispatch({ type: 'HANDOFF', artwork: handoff.artwork, tier: handoff.tier, handoff: handoff.info });
  }, [handoff]);

  // Move focus to the new step's heading for keyboard and screen-reader users.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const h = mainRef.current?.querySelector<HTMLElement>('h1');
    h?.focus();
  }, [state.step]);

  const ctx: MintContextValue = useMemo(
    () => ({ app, services, vault: vaultRef.current, store, state, dispatch }),
    [app, services, store, state],
  );

  const screens = (
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

  if (embedded) {
    return (
      <MintContext.Provider value={ctx}>
        <div className="mint-shell">
          <Header />
          <ProgressNav />
          <div ref={mainRef} className="main">
            {screens}
          </div>
          <p className="mint-shell__note">
            Non-custodial by design: your one-time reveal key stays with you (in your recovery bundle, never on our
            server), and the server only ever holds a half-signed transaction that pays <em>you</em>. Network:{' '}
            <span className="mono">{app.network}</span>.
          </p>
        </div>
      </MintContext.Provider>
    );
  }

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
      <div className="mint-shell">
        <Header />
        <ProgressNav />
        <main id="main" ref={mainRef} className="main">
          {screens}
        </main>
        <footer className="footer">
          <p>
            The Decentralized Gentlemen Club · non-custodial by design: your one-time reveal key stays with you (in your
            recovery bundle, never on our server), and the server only ever holds a half-signed transaction that pays{' '}
            <em>you</em>.
          </p>
          <p className="muted small">
            Network: <span className="mono">{app.network}</span>
            {services.mode === 'demo' ? ' · demo mode' : ''}
          </p>
        </footer>
      </div>
    </MintContext.Provider>
  );
}
