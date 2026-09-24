/**
 * Artist Studio session (ADR-0007 §2-3): Sign in with Bitcoin using the connected wallet.
 *
 *   signIn:   POST /auth/challenge → wallet.signMessage(message, address, 'bip322-simple')
 *             → POST /auth/verify → session token (memory + sessionStorage)
 *   payout:   wallet.signMessage("degent.club payout address <address> for <sessionSub>", address)
 *             → PUT /artists/me { payout: { address, signature } }
 *
 * The token lives in React state and, best effort, in sessionStorage so a reload does not ask for
 * another signature. It is never put in a URL.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMint } from './context';
import type { StudioArtist } from '../services/studioApi';
import { StudioApiError } from '../services/studioApi';
import {
  clearStudioSession,
  LegacyPayoutError,
  loadStudioSession,
  payoutAddressKind,
  payoutMessage,
  saveStudioSession,
  type StudioSession,
} from '../lib/studioSession';
import { errorText } from '../components/ui';

export interface StudioContextValue {
  session: StudioSession | null;
  artist: StudioArtist | null;
  /** True while a stored session is being checked against GET /artists/me. */
  restoring: boolean;
  busy: 'sign-in' | 'payout' | 'profile' | null;
  error: string | null;
  /** Sign in with the wallet's ordinals address (the artist's identity). */
  signIn(): Promise<void>;
  signOut(): void;
  /** Prove a payout address by signing the fixed message with it, then store it. */
  provePayout(address: string): Promise<void>;
  setDisplayName(name: string): Promise<void>;
  setArtist(a: StudioArtist): void;
  clearError(): void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const v = useContext(StudioContext);
  if (!v) throw new Error('useStudio must be used inside <StudioProvider>');
  return v;
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const { services, app, state, sessionStore } = useMint();
  const wallet = state.wallet;
  const [session, setSession] = useState<StudioSession | null>(() => loadStudioSession(sessionStore));
  const [artist, setArtistState] = useState<StudioArtist | null>(null);
  const [restoring, setRestoring] = useState<boolean>(() => loadStudioSession(sessionStore) !== null);
  const [busy, setBusy] = useState<StudioContextValue['busy']>(null);
  const [error, setError] = useState<string | null>(null);
  const restored = useRef(false);

  const signOut = useCallback(() => {
    setSession(null);
    setArtistState(null);
    clearStudioSession(sessionStore);
  }, [sessionStore]);

  // A session from a previous page load: check it is still good before trusting it.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const s = loadStudioSession(sessionStore);
    if (!s) {
      setRestoring(false);
      return;
    }
    let alive = true;
    services.studio
      .getMe(s.token)
      .then((a) => {
        if (!alive) return;
        setArtistState(a);
      })
      .catch(() => {
        if (!alive) return;
        signOut();
      })
      .finally(() => alive && setRestoring(false));
    return () => {
      alive = false;
    };
  }, [services, sessionStore, signOut]);

  const signIn = useCallback(async () => {
    if (!wallet) {
      setError('Connect a wallet first: the studio signs you in with it.');
      return;
    }
    if (!wallet.signMessage) {
      setError(`${wallet.name} cannot sign messages, so it cannot sign in with Bitcoin. Try another wallet.`);
      return;
    }
    setBusy('sign-in');
    setError(null);
    try {
      const address = wallet.ordinals.address;
      const challenge = await services.studio.challenge(address, app.network);
      const signature = await wallet.signMessage(challenge.message, address, 'bip322-simple');
      const s = await services.studio.verify({ message: challenge.message, signature, address });
      const next: StudioSession = { token: s.token, address, expiresAt: s.expiresAt, method: s.method };
      setSession(next);
      setArtistState(s.artist);
      saveStudioSession(next, sessionStore);
    } catch (e) {
      setError(e instanceof StudioApiError ? `${e.message} (${e.code})` : errorText(e));
    } finally {
      setBusy(null);
    }
  }, [wallet, services, app.network, sessionStore]);

  const provePayout = useCallback(
    async (address: string) => {
      if (!session || !wallet?.signMessage) {
        setError('Sign in first.');
        return;
      }
      const kind = payoutAddressKind(address);
      if (kind === 'legacy') {
        setError(new LegacyPayoutError(address).message);
        return;
      }
      setBusy('payout');
      setError(null);
      try {
        const message = payoutMessage(address, session.address);
        const signature = await wallet.signMessage(message, address, 'bip322-simple');
        const a = await services.studio.updateMe(session.token, { payout: { address, signature } });
        setArtistState(a);
      } catch (e) {
        if (e instanceof StudioApiError && e.code === 'payout_address_legacy') setError(new LegacyPayoutError(address).message);
        else setError(e instanceof StudioApiError ? `${e.message} (${e.code})` : errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [session, wallet, services],
  );

  const setDisplayName = useCallback(
    async (name: string) => {
      if (!session) return;
      setBusy('profile');
      setError(null);
      try {
        const a = await services.studio.updateMe(session.token, { displayName: name.trim() === '' ? null : name.trim() });
        setArtistState(a);
      } catch (e) {
        setError(e instanceof StudioApiError ? `${e.message} (${e.code})` : errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [session, services],
  );

  const value = useMemo<StudioContextValue>(
    () => ({
      session,
      artist,
      restoring,
      busy,
      error,
      signIn,
      signOut,
      provePayout,
      setDisplayName,
      setArtist: setArtistState,
      clearError: () => setError(null),
    }),
    [session, artist, restoring, busy, error, signIn, signOut, provePayout, setDisplayName],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
