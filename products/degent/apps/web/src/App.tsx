import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { AppConfig } from './config';
import type { Services } from './services/types';
import { MintContext, type MintContextValue } from './flow/context';
import { flowReducer } from './flow/reducer';
import { initialState, type FlowState } from './flow/state';
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
}

export function App({ app, services, store = browserStore(), vault: vaultProp, initial }: AppProps) {
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
      <ProgressNav />
      <main id="main" ref={mainRef} className="main">
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
      </main>
      <footer className="footer">
        <p>
          The Decentralized Gentlemen Club · non-custodial by design: your reveal key never leaves this tab, and the
          server only ever holds a half-signed transaction that pays <em>you</em>.
        </p>
        <p className="muted small">
          Network: <span className="mono">{app.network}</span>
          {services.mode === 'demo' ? ' · demo mode' : ''}
        </p>
      </footer>
    </MintContext.Provider>
  );
}
