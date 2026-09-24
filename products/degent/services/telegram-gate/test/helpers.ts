import { getAddress, NETWORK } from '@scure/btc-signer';
import { InMemoryNonceStore, SessionKeyRing, signBip322Simple, signLegacyMessage, type NonceStore } from '@bsh/identity';
import { createApp } from '../src/app.js';
import { GateService, type GateSettings } from '../src/application/gate-service.js';
import { MemoryHolderRegistry } from '../src/adapters/memory-holder-registry.js';
import { MemoryMemberStore } from '../src/adapters/memory-member-store.js';
import { MemoryTelegramApi } from '../src/adapters/memory-telegram.js';
import type { MemberStore } from '../src/ports/member-store.js';

/** Real-clock anchored (InMemoryNonceStore sweeps with Date.now()), whole seconds. */
export const T0 = Math.floor(Date.now() / 1000) * 1000;
export const CHAT = '-1001234567890';
export const WEB = 'https://degent.club';

/** Deterministic test keys (never use outside tests). */
export const key = (n: number): Uint8Array => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));

export interface TestWallet {
  address: string;
  sign(message: string): string;
}

export function wallet(n: number, kind: 'tr' | 'wpkh' | 'pkh' = 'tr'): TestWallet {
  const priv = key(n);
  const address = getAddress(kind, priv, NETWORK)!;
  return {
    address,
    sign: (m) => (kind === 'pkh' ? signLegacyMessage(priv, m, 'p2pkh') : signBip322Simple(priv, kind === 'tr' ? 'p2tr' : 'p2wpkh', m)),
  };
}

export function settings(o: Partial<GateSettings> = {}): GateSettings {
  return {
    network: 'mainnet',
    holdersChatId: CHAT,
    webBaseUrl: WEB,
    siwbDomain: 'degent.club',
    siwbUri: WEB,
    linkSecret: 'g'.repeat(40),
    linkTtlSeconds: 600,
    inviteTtlSeconds: 600,
    verifyRateLimit: { max: 3, windowMs: 10 * 60 * 1000 },
    adminAddresses: [],
    sessionTtlSeconds: 3600,
    ...o,
  };
}

export function makeGate(o: { holdings?: Record<string, number[] | Error>; settings?: Partial<GateSettings>; members?: MemberStore; nonces?: NonceStore } = {}) {
  let t = T0;
  const now = () => t;
  const members = o.members ?? new MemoryMemberStore();
  const telegram = new MemoryTelegramApi();
  const holders = new MemoryHolderRegistry(o.holdings);
  const nonces = o.nonces ?? new InMemoryNonceStore();
  const sessions = new SessionKeyRing({ kid: 'test-1', secretKey: key(9_999) });
  const s = settings(o.settings);
  const service = new GateService({ settings: s, members, holders, telegram, nonces, sessions, now });
  const app = createApp({ service, corsOrigins: [WEB], now, rateLimit: { windowMs: 60_000, max: 1000 } });
  return {
    service,
    app,
    members,
    telegram,
    holders,
    nonces,
    sessions,
    settings: s,
    now,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export type Gate = ReturnType<typeof makeGate>;

export async function linkFor(g: Gate, tg: number): Promise<string> {
  const { url } = await g.service.startVerification(tg);
  return new URL(url).searchParams.get('tg')!;
}

/** /verify -> challenge -> wallet signs -> verify. */
export async function verifyFlow(g: Gate, tg: number, w: TestWallet) {
  const token = await linkFor(g, tg);
  const ch = await g.service.challenge({ token, address: w.address });
  const signature = w.sign(ch.message);
  const result = await g.service.verify({ token, address: w.address, message: ch.message, signature });
  return { token, ch, signature, result };
}

export async function post(g: Gate, path: string, body: unknown, headers: Record<string, string> = {}) {
  return g.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
