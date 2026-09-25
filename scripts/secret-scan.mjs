#!/usr/bin/env node
/**
 * secret-scan: look for committed secrets in every blob reachable from any ref (the full git history) and in
 * the tracked working tree. Patterns: PEM private keys, Bitcoin WIF keys and BIP32 extended private keys
 * (base58check-verified), BIP39-style seed phrases, age secret keys, AWS access keys, Telegram bot tokens,
 * JWTs, and vendor API keys.
 *
 *   node scripts/secret-scan.mjs              # history + working tree; exit 1 on any finding
 *   node scripts/secret-scan.mjs --worktree   # tracked working tree only (fast pre-commit use)
 *   node scripts/secret-scan.mjs --json       # machine-readable findings
 *
 * Test fixtures that must look like secrets are allowlisted EXPLICITLY below: a path, the rule, and why.
 * A hit is printed with its path, rule and a redacted excerpt (never the full value). Wired into CI and
 * `pnpm check` (`pnpm test:secrets`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Explicit allowlist: { path (exact, or a prefix ending in '/'), rule, sha256 of the exact value (optional; set it
 * for anything that is not a whole file of synthetic data), why }. Keep it short; every entry is a decision someone
 * can review. Values are published test vectors or deliberately fake shapes, never real keys.
 */
export const ALLOWLIST = [
  { path: 'scripts/secret-scan.mjs', rule: '*', why: 'this file documents the patterns' },
  { path: 'test/secret-scan.test.ts', rule: '*', why: 'synthetic secrets proving each rule fires' },
  {
    path: '.gitleaks.toml',
    rule: 'bitcoin-wif',
    sha256: '07d7f8ceabf89d345db86b041a59b94d72f9c4c964febb21e9bdb8b9a1c6348e',
    why: 'BIP-322 published test-vector key (bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l), allowlisted by value in the former gitleaks config (history only)',
  },
  {
    path: 'products/degent/services/mint/src/adapters/reveal-vault.ts',
    rule: 'hex-private-key',
    sha256: '3f8b78d0fefbd23dd4bb8fa71f5c16f13b34ae134db19d86d5b1ce9248be59b4',
    why: "REGTEST_DEV_REVEAL_KEY: ASCII 'degnt-mint-regtest-only-dev-key!'; config.ts refuses it off regtest",
  },
  {
    path: 'platform/identity/test/helpers.ts',
    rule: 'bitcoin-wif',
    sha256: '07d7f8ceabf89d345db86b041a59b94d72f9c4c964febb21e9bdb8b9a1c6348e',
    why: 'BIP322_WIF test-signing key; same published BIP-322 test-vector value as the .gitleaks.toml entry, in a pre-split history path (platform lives in the deps/scribbit submodule now, ADR-0004)',
  },
];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58checkPayload(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  const buf = Buffer.from(bytes);
  if (buf.length < 5) return null;
  const body = buf.subarray(0, -4);
  const sum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  return sum.equals(buf.subarray(-4)) ? body : null;
}

/** WIF: version 0x80 (mainnet) / 0xef (test networks), 32-byte key, optional 0x01 compression flag. */
const isWif = (s) => {
  const p = base58checkPayload(s);
  return !!p && (p[0] === 0x80 || p[0] === 0xef) && (p.length === 33 || (p.length === 34 && p[33] === 0x01));
};
/** BIP32 extended key: 78-byte payload whose key data starts with 0x00 (a private key). */
const isXprv = (s) => {
  const p = base58checkPayload(s);
  return !!p && p.length === 78 && p[45] === 0x00;
};

const seedLengths = new Set([12, 15, 18, 21, 24]);

export const RULES = [
  { id: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'bitcoin-wif', re: /(?<![1-9A-HJ-NP-Za-km-z])[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])/g, verify: isWif },
  { id: 'bip32-xprv', re: /(?<![1-9A-HJ-NP-Za-km-z])[xtyzuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{100,112}(?![1-9A-HJ-NP-Za-km-z])/g, verify: isXprv },
  {
    id: 'seed-phrase',
    // 12-24 lower-case words assigned to a mnemonic / seed / recovery-phrase name (without the BIP-39 wordlist,
    // an unlabelled quoted sentence cannot be told from a test title).
    re: /\b[a-z0-9_]*(?:mnemonic|seed_?phrase|recovery_?phrase|seed)[a-z0-9_]*\b["']?\s*[:=]\s*["'`]((?:[a-z]{3,8} ){11,23}[a-z]{3,8})["'`]/gi,
    verify: (_m, words) => seedLengths.has(words.split(' ').length) && words === words.toLowerCase(),
  },
  {
    id: 'hex-private-key',
    // A 32-byte hex literal assigned to a private-key / secret / seed / signing-key name. Deterministic test keys
    // made of one repeated byte (e.g. '11' x 32) are not secrets and are skipped.
    re: /\b[a-z0-9_]*(?:priv|secret|seed|signing_?key|reveal_?key|parent_?key|nsec)[a-z0-9_]*\b["']?\s*[:=]\s*(?:hex\.decode\(\s*|hexToBytes\(\s*|Buffer\.from\(\s*)?["'`]([0-9a-f]{64})["'`]/gi,
    verify: (_m, v) => !/^([0-9a-f]{2})\1{31}$/i.test(v),
  },
  { id: 'age-secret-key', re: /AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}/g },
  { id: 'aws-access-key-id', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g },
  { id: 'aws-secret-access-key', re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi },
  { id: 'telegram-bot-token', re: /(?<![0-9A-Za-z])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g },
  { id: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g },
  { id: 'vendor-api-key', re: /(?<![A-Za-z0-9])(?:sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,}|sk-(?:proj-)?[A-Za-z0-9]{40,}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{20,})/g },
];

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Path AND rule AND (when given) the SHA-256 of the exact value: the same value elsewhere is still reported. */
const allowed = (path, rule, value) =>
  ALLOWLIST.some(
    (a) =>
      (a.rule === '*' || a.rule === rule) &&
      (a.path.endsWith('/') ? path.startsWith(a.path) : path === a.path) &&
      (a.sha256 === undefined || a.sha256 === sha256(value)),
  );

const redact = (s) => (s.length <= 12 ? `${s.slice(0, 2)}…` : `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} chars)`);

/** Findings in one text. */
export function scanText(text, path) {
  const out = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = m[1] ?? m[0];
      if (rule.verify && !rule.verify(m[0], value)) continue;
      if (allowed(path, rule.id, value)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ path, line, rule: rule.id, excerpt: redact(value) });
    }
  }
  return out;
}

const git = (args, opts = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30, ...opts });
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Every blob reachable from any ref, once, with the first path it was seen at. */
function historyBlobs() {
  const lines = git(['rev-list', '--all', '--objects'], { encoding: 'utf8' }).split('\n');
  const paths = new Map();
  for (const l of lines) {
    const sp = l.indexOf(' ');
    if (sp < 0) continue;
    const sha = l.slice(0, sp);
    if (!paths.has(sha)) paths.set(sha, l.slice(sp + 1));
  }
  const shas = [...paths.keys()];
  if (shas.length === 0) return [];
  const types = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: shas.join('\n'), encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.split(' '))
    .filter(([, t, size]) => t === 'blob' && Number(size) <= 16 * 1024 * 1024);
  const blobs = [];
  const res = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: types.map(([s]) => s).join('\n'), maxBuffer: 1 << 30 });
  const buf = res.stdout;
  let off = 0;
  for (const [sha] of types) {
    const nl = buf.indexOf(10, off);
    const [, , size] = buf.subarray(off, nl).toString().split(' ');
    const start = nl + 1;
    const content = buf.subarray(start, start + Number(size));
    off = start + Number(size) + 1;
    blobs.push({ path: paths.get(sha), sha, content });
  }
  return blobs;
}

function worktreeFiles() {
  return git(['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((path) => {
      try {
        return { path, content: readFileSync(join(root, path)) };
      } catch {
        return null; // deleted in the working tree, or a submodule
      }
    })
    .filter((x) => x !== null);
}

/** `.env` files must never be tracked; generated `*.example` files are the only exception. */
export const isEnvFile = (path) => /(^|\/)\.env(\.[^/]*)?$/.test(path) && !/\.example$/.test(path);

export function scan({ history = true } = {}) {
  const seen = new Set();
  const findings = [];
  const inputs = [...(history ? historyBlobs() : []), ...worktreeFiles()];
  const everyPath = new Set(inputs.map((i) => i.path));
  if (history)
    for (const l of git(['rev-list', '--all', '--objects'], { encoding: 'utf8' }).split('\n')) {
      const sp = l.indexOf(' ');
      if (sp > 0) everyPath.add(l.slice(sp + 1));
    }
  for (const path of everyPath) if (isEnvFile(path)) findings.push({ path, line: 0, rule: 'tracked-env-file', excerpt: '(file is tracked)' });
  for (const { path, content } of inputs) {
    if (!content || isBinary(content)) continue;
    const key = `${path}\0${createHash('sha1').update(content).digest('hex')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(...scanText(content.toString('utf8'), path));
  }
  const unique = new Map(findings.map((f) => [`${f.path}:${f.line}:${f.rule}:${f.excerpt}`, f]));
  return { scanned: seen.size, findings: [...unique.values()] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = Date.now();
  const r = scan({ history: !process.argv.includes('--worktree') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const f of r.findings) console.log(`${f.path}:${f.line}  ${f.rule}  ${f.excerpt}`);
    console.log(`secret-scan: ${r.scanned} files/blobs scanned in ${Date.now() - t0} ms, ${r.findings.length} finding(s)`);
  }
  process.exit(r.findings.length ? 1 : 0);
}
