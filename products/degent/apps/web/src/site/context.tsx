import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList } from 'react';
import type { AppConfig } from '../config';
import type { Services } from '../services/types';
import type { MintHandoff } from '../App';
import type { SiteServices } from './services/types';

export interface SiteContextValue {
  app: AppConfig;
  site: SiteServices;
  mint: Services;
  handoff: MintHandoff | null;
  /** Hand exact bytes to the /mint flow and navigate there. */
  sendToMint(h: Omit<MintHandoff, 'id'>): void;
}

export const SiteContext = createContext<SiteContextValue | null>(null);

export function useSite(): SiteContextValue {
  const v = useContext(SiteContext);
  if (!v) throw new Error('useSite must be used inside the site');
  return v;
}

export type Async<T> =
  | { status: 'loading'; value: null; error: null }
  | { status: 'ok'; value: T; error: null }
  | { status: 'error'; value: null; error: string };

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run `fn` on mount / when deps change; ignores results from stale runs. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): Async<T> & { reload(): void } {
  const [state, setState] = useState<Async<T>>({ status: 'loading', value: null, error: null });
  const [tick, setTick] = useState(0);
  const run = useRef(0);
  useEffect(() => {
    const my = ++run.current;
    setState((s) => (s.status === 'loading' ? s : { status: 'loading', value: null, error: null }));
    fn().then(
      (value) => my === run.current && setState({ status: 'ok', value, error: null }),
      (e) => my === run.current && setState({ status: 'error', value: null, error: errorMessage(e) }),
    );
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Whether a TODO(copy) page is visible: always in demo, in production only once its copy shipped. */
export function copyVisible(app: AppConfig, page: 'manifesto' | 'about'): boolean {
  return app.demo || app.copyReady.has(page);
}
