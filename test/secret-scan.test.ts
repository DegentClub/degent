/**
 * scripts/secret-scan.mjs: every rule fires on a synthetic secret, near-misses and deterministic test keys do
 * not, the allowlist matches path AND value, and the repository's full history is clean. Synthetic values are
 * assembled at runtime so no scanner (this one, or a forge's push protection) sees a literal secret here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { RULES, isEnvFile, scan, scanText } from '../scripts/secret-scan.mjs';

type Finding = { path: string; line: number; rule: string; excerpt: string };
const rulesIn = (text: string, path = 'src/example.ts') => (scanText(text, path) as Finding[]).map((f) => f.rule);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58check(payload: Buffer): string {
  const sum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  const buf = Buffer.concat([payload, sum]);
  let n = BigInt(`0x${buf.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const wif = (version: number, compressed: boolean) =>
  base58check(Buffer.concat([Buffer.of(version), randomBytes(32), compressed ? Buffer.of(1) : Buffer.alloc(0)]));
const xprv = (version: string) =>
  base58check(Buffer.concat([Buffer.from(version, 'hex'), Buffer.alloc(1 + 4 + 4), randomBytes(32), Buffer.of(0), randomBytes(32)]));
const alnum = (n: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') =>
  Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('secret-scan rules', () => {
  it('each rule fires on a synthetic secret', () => {
    const cases: Array<[string, string]> = [
      ['pem-private-key', `const k = \`-----BEGIN ${'PRIVATE'} KEY-----\nMIIE...\``],
      ['pem-private-key', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`],
      ['bitcoin-wif', `key = "${wif(0x80, true)}"`],
      ['bitcoin-wif', `key = "${wif(0x80, false)}"`],
      ['bitcoin-wif', `testnet: ${wif(0xef, true)}`],
      ['bip32-xprv', `"${xprv('0488ade4')}"`],
      ['bip32-xprv', `${xprv('04358394')}`],
      ['seed-phrase', `mnemonic = "${Array.from({ length: 12 }, (_, i) => ['zoo', 'wrong', 'legal', 'winner'][i % 4]).join(' ')}"`],
      ['seed-phrase', `SEED_PHRASE: '${Array.from({ length: 24 }, () => 'abandon').join(' ')}'`],
      ['hex-private-key', `const revealPrivkey = '${randomBytes(32).toString('hex')}';`],
      ['hex-private-key', `PARENT_KEY=${'"'}${randomBytes(32).toString('hex')}"`],
      ['age-secret-key', `AGE-SECRET-KEY-1${alnum(58, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'.toUpperCase())}`],
      ['aws-access-key-id', `aws_access_key_id = ${'AKIA'}${alnum(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`],
      ['aws-secret-access-key', `aws_secret_access_key = ${alnum(40)}`],
      ['telegram-bot-token', `TELEGRAM_BOT_TOKEN=${'123456789'}:AA${alnum(33)}`],
      ['jwt', `Authorization: Bearer ${b64url({ alg: 'EdDSA', typ: 'JWT' })}.${b64url({ sub: 'bc1p', exp: 1 })}.${alnum(43)}`],
      ['vendor-api-key', `ART_REVIEW_API_KEY=${'sk-ant-'}api03-${alnum(80)}`],
      ['vendor-api-key', `token: ${'ghp_'}${alnum(36)}`],
    ];
    for (const [rule, text] of cases) expect(rulesIn(text), `${rule}: ${text.slice(0, 40)}`).toContain(rule);
    const ids = new Set((RULES as Array<{ id: string }>).map((r) => r.id));
    for (const [rule] of cases) expect(ids.has(rule)).toBe(true);
    expect([...ids].every((id) => cases.some(([r]) => r === id))).toBe(true);
  });

  it('does not fire on near-misses: bad checksums, txids, test titles, deterministic keys, public keys', () => {
    const good = wif(0x80, true);
    const bad = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect(rulesIn(`"${bad}"`)).toEqual([]);
    expect(rulesIn(`txid: '${randomBytes(32).toString('hex')}'`)).toEqual([]);
    expect(rulesIn(`it('clamps the target into the tier and reports designs that cannot fit', () => {})`)).toEqual([]);
    expect(rulesIn(`const TEST_KEY = '${'11'.repeat(32)}'; const secretKey = '${'22'.repeat(32)}';`)).toEqual([]);
    expect(rulesIn(`xpub = "${base58check(Buffer.concat([Buffer.from('0488b21e', 'hex'), Buffer.alloc(9), randomBytes(32), Buffer.of(2), randomBytes(32)]))}"`)).toEqual([]);
    expect(rulesIn(`BITCOIN_ADDRESS=bc1p${'q'.repeat(58)}`)).toEqual([]);
  });

  it('never prints the secret: excerpts are redacted', () => {
    const k = wif(0x80, true);
    const [f] = scanText(`k = "${k}"`, 'src/x.ts') as Finding[];
    expect(f!.excerpt).not.toContain(k);
    expect(f!.excerpt).toMatch(/…/);
  });

  it('the allowlist matches path AND value: the allowlisted test vector anywhere else is still reported', () => {
    const vector = ['L3VFeEujGtevx9w18HD1f', 'hRbCH67Az2dpCymeRE1SoPK6XQtaN2k'].join('');
    expect(rulesIn(`key = '${vector}'`, '.gitleaks.toml')).toEqual([]);
    expect(rulesIn(`key = '${vector}'`, 'src/other.ts')).toEqual(['bitcoin-wif']);
    expect(rulesIn(`key = '${wif(0x80, true)}'`, '.gitleaks.toml')).toEqual(['bitcoin-wif']);
  });

  it('only generated .env examples may be tracked', () => {
    expect(isEnvFile('.env')).toBe(true);
    expect(isEnvFile('products/degent/deploy/.env.mainnet')).toBe(true);
    expect(isEnvFile('products/degent/deploy/.env.mainnet.example')).toBe(false);
    expect(isEnvFile('src/env.ts')).toBe(false);
  });
});

describe('the repository', () => {
  it('has no secrets and no tracked .env file anywhere in its git history or working tree', () => {
    const r = scan({ history: true }) as { scanned: number; findings: Finding[] };
    expect(r.scanned).toBeGreaterThan(100);
    expect(r.findings).toEqual([]);
  });
});
