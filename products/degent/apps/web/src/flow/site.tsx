/**
 * Site data shared by every page: the block.space certificate (loaded once), the lazily walked member
 * index and the ord details cache. One source for every count (site spec "Known defects"); in demo mode
 * the fake certificate is used and the UI labels it as demo data.
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useMint } from './context';
import { errorText } from '../components/ui';
import { countsFrom, type CollectionCounts } from '../lib/counts';
import { createDetailsCache, type DetailsCache } from '../lib/detailsCache';
import { createMemberIndex, type MemberIndex } from '../lib/memberIndex';
import type { CollectionResponse } from '../services/certifyApi';
import type { OrdInscription } from '../services/ordApi';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../lib/theme';

export type CertificateState =
  | { status: 'loading' }
  | { status: 'ready'; data: CollectionResponse; counts: CollectionCounts }
  | { status: 'error'; error: string };

export interface SiteContextValue {
  slug: string;
  certificate: CertificateState;
  members: MemberIndex;
  details: DetailsCache;
  /** True when the counts come from the demo fake (always labelled in the UI). */
  demo: boolean;
  theme: Theme;
  setTheme(theme: Theme): void;
}

const SiteContext = createContext<SiteContextValue | null>(null);

export function SiteProvider({ children }: { children: ReactNode }) {
  const { services, app, store } = useMint();
  const slug = app.collectionSlug;
  const [theme, setThemeState] = useState<Theme>(() => loadTheme(store));
  useEffect(() => applyTheme(theme), [theme]);
  const [certificate, setCertificate] = useState<CertificateState>({ status: 'loading' });
  const members = useMemo(() => createMemberIndex(services.certify, slug), [services.certify, slug]);
  const details = useMemo(() => createDetailsCache(services.ord), [services.ord]);

  useEffect(() => {
    let alive = true;
    setCertificate({ status: 'loading' });
    services.certify
      .getCollection(slug)
      .then((data) => alive && setCertificate({ status: 'ready', data, counts: countsFrom(data.attestation) }))
      .catch((e) => alive && setCertificate({ status: 'error', error: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [services.certify, slug]);

  const value = useMemo(
    () => ({
      slug,
      certificate,
      members,
      details,
      demo: services.mode === 'demo',
      theme,
      setTheme: (t: Theme) => {
        saveTheme(t, store);
        setThemeState(t);
      },
    }),
    [slug, certificate, members, details, services.mode, theme, store],
  );
  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteContextValue {
  const v = useContext(SiteContext);
  if (!v) throw new Error('useSite must be used inside <SiteProvider>');
  return v;
}

/** The counts when the certificate is loaded, else null. */
export function useCounts(): CollectionCounts | null {
  const { certificate } = useSite();
  return certificate.status === 'ready' ? certificate.counts : null;
}

/** ord details of one inscription from the shared cache (re-renders when it settles). */
export function useOrdDetails(id: string | null): OrdInscription | null | undefined {
  const { details } = useSite();
  const value = useSyncExternalStore(
    details.subscribe,
    () => (id ? details.peek(id) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (id) void details.get(id);
  }, [id, details]);
  return value;
}
