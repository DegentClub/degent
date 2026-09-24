#!/usr/bin/env node
/**
 * Signet rehearsal checklist runner (docs/REHEARSAL.md). Drives the PUBLIC mint API only and writes a
 * machine-readable report (rehearsal-report.json).
 *
 *   node scripts/rehearsal/run.mjs --base-url http://127.0.0.1:8080/api --auto
 *   node scripts/rehearsal/run.mjs --base-url https://signet.degent.club/api --orders orders.json --wait
 *
 * Scenario modes (scripts/rehearsal/scenarios.json):
 *   auto    the runner does everything: health/config/fees/queue checks, create an order with a generated
 *           fixture image and upload it (binding quote, never paid), intake refusals (policy).
 *   manual  a human does the money path in the web app with a real wallet (pay, members vote, rescue,
 *           outage drills); the runner is given the order id (`--orders file.json` = {"<scenario>": "dgt_..."}
 *           or `--order <scenario>=<id>`) and checks the order's final state and path from its public
 *           timeline, recording pay -> confirm -> approve -> delivered timings.
 *
 * The runner never sees a key, a PSBT or an order token and never pays. It refuses to create orders on
 * mainnet unless --allow-mainnet (they would only expire, but a rehearsal tool has no business there).
 * Exit code: 0 when no scenario failed (pending/skipped are not failures), 1 otherwise, 2 on usage errors.
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPORT_VERSION = 1;
const DEFAULT_SCENARIOS = fileURLToPath(new URL('./scenarios.json', import.meta.url));

// ------------------------------------------------------------------------------------------ fixtures

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A structurally valid PNG of `width` x `height` padded to exactly `totalBytes` with a private ancillary
 * chunk ("deGt") of deterministic filler. It passes the service's magic-byte and header-dimension review;
 * it is a test fixture, not art (do not inscribe it on mainnet).
 */
export function fixturePng(width, height, totalBytes, seed = 7) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const head = [sig, pngChunk('IHDR', ihdr)];
  const iend = pngChunk('IEND', new Uint8Array(0));
  const base = head.reduce((n, p) => n + p.length, 0) + iend.length;
  const parts = [...head];
  if (totalBytes > base + 12) {
    const fill = new Uint8Array(totalBytes - base - 12);
    let x = seed;
    for (let i = 0; i < fill.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      fill[i] = x >>> 24;
    }
    parts.push(pngChunk('deGt', fill));
  }
  parts.push(iend);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A fresh secp256k1 x-only public key (hex). Stands in for the browser's ephemeral K_e; the secret is dropped. */
export function randomXOnlyPubkey() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
}

// bech32m (BIP-350) for witness v1 addresses
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
function convertBits(data, from, to) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & ((1 << to) - 1));
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
const HRP = { mainnet: 'bc', testnet: 'tb', signet: 'tb', regtest: 'bcrt' };

/** Taproot (P2TR) address paying to the 32-byte x-only key `xonlyHex` on `network`. */
export function taprootAddress(xonlyHex, network) {
  const hrp = HRP[network];
  if (!hrp) throw new Error(`unknown network ${network}`);
  const data = [1, ...convertBits(Buffer.from(xonlyHex, 'hex'), 8, 5)];
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expand, ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

// ------------------------------------------------------------------------------------------ API client

function client(baseUrl, fetchImpl) {
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (method, path, { json, bytes, token } = {}) => {
    const headers = {};
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    if (bytes) {
      headers['content-type'] = 'application/octet-stream';
      body = bytes;
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const t0 = performance.now();
    const res = await fetchImpl(`${base}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed, ms: Math.round(performance.now() - t0) };
  };
  return { call };
}

// ------------------------------------------------------------------------------------------ scenarios

/** Timestamps of the first entry into each status, and the pay -> confirm -> approve -> delivered timings. */
export function timingsFromTimeline(timeline = []) {
  const first = {};
  for (const e of timeline) if (!(e.status in first)) first[e.status] = e.at;
  const t = (s) => (first[s] ? Date.parse(first[s]) : null);
  const secs = (a, b) => (a !== null && b !== null ? Math.round((b - a) / 1000) : null);
  const paid = t('paid');
  const confirmed = t('member_review'); // entered once the commit has the required confirmations
  const decided = t('queued') ?? t('declined') ?? t('rescue_available');
  const delivered = t('delivered');
  return {
    paidAt: first.paid ?? null,
    confirmedAt: first.member_review ?? null,
    approvedAt: first.queued ?? null,
    declinedAt: first.declined ?? null,
    rescueOfferedAt: first.rescue_available ?? null,
    revealedAt: first.revealed ?? null,
    deliveredAt: first.delivered ?? null,
    payToConfirmSec: secs(paid, confirmed),
    confirmToApproveSec: secs(confirmed, decided),
    approveToDeliveredSec: secs(t('queued'), delivered),
    payToDeliveredSec: secs(paid, delivered),
  };
}

const TERMINAL = new Set(['delivered', 'rejected', 'expired', 'failed']);

async function runAuto(s, api, ctx) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  const extra = {};

  for (const step of s.steps ?? []) {
    if (step === 'health') {
      const r = await api.call('GET', '/v1/health');
      check('health', r.status === 200 && r.body?.status === 'ok', { status: r.body?.status, checks: r.body?.checks, ms: r.ms });
    } else if (step === 'config') {
      const r = await api.call('GET', '/v1/config');
      check('config', r.status === 200 && r.body?.network === ctx.network && Array.isArray(r.body?.tiers), {
        network: r.body?.network,
        tiers: r.body?.tiers?.map((t) => t.tier),
        collectionAddress: r.body?.collectionAddress,
        ms: r.ms,
      });
    } else if (step === 'fees') {
      const r = await api.call('GET', '/v1/fees');
      check('fees', r.status === 200 && r.body?.standard?.normal >= r.body?.minFeeRate, { standard: r.body?.standard, block: r.body?.block, ms: r.ms });
    } else if (step === 'queue') {
      const r = await api.call('GET', '/v1/queue');
      check('queue', r.status === 200, { ms: r.ms });
    } else if (step === 'create') {
      if (ctx.network === 'mainnet' && !ctx.allowMainnet) {
        check('create', false, 'refusing to create orders on mainnet (use --allow-mainnet)');
        continue;
      }
      const tier = s.tier ?? 'standard';
      const rule = ctx.config.tiers.find((t) => t.tier === tier);
      if (!rule) {
        check('create', s.expectTierMissing === true, `tier ${tier} not offered by this service`);
        continue;
      }
      const size = Math.min(Math.max(rule.minBytes, s.bytes ?? rule.minBytes + 1024), rule.maxBytes);
      const side = Math.min(Math.max(ctx.config.minDimensionPx ?? 1, 1024), ctx.config.maxDimensionPx ?? 1024);
      const img = fixturePng(side, side, size, ctx.seed++);
      const feeRate = Math.max(ctx.fees?.standard?.normal ?? 2, ctx.config.minFeeRate ?? 1);
      const req = {
        tier,
        contentType: 'image/png',
        contentLength: img.length,
        contentSha256: sha256Hex(img),
        recipientAddress: ctx.recipient ?? taprootAddress(randomXOnlyPubkey(), ctx.network),
        revealPubkey: randomXOnlyPubkey(),
        feeRate,
      };
      const created = await api.call('POST', '/v1/orders', { json: req });
      check('create', created.status === 201 && created.body?.order?.status === 'awaiting_content', { status: created.status, ms: created.ms, error: created.body?.error?.code });
      if (created.status !== 201) continue;
      extra.orderId = created.body.order.id;
      const up = await api.call('PUT', `/v1/orders/${extra.orderId}/content`, { bytes: img, token: created.body.orderToken });
      const q = up.body?.quote;
      check('upload+review', up.status === 200 && up.body?.status === 'approved' && q?.binding === true && typeof q?.commitAddress === 'string', {
        status: up.body?.status ?? up.status,
        lane: q?.lane,
        commitValueSats: q?.commitValueSats,
        ms: up.ms,
      });
      extra.lane = q?.lane ?? tier;
    } else if (step === 'refusals') {
      for (const c of s.cases ?? []) checks.push(await runRefusal(c, api, ctx));
    } else {
      check(step, false, 'unknown step');
    }
  }
  const failed = checks.filter((c) => !c.ok);
  return { result: failed.length ? 'fail' : 'pass', reason: failed.length ? failed.map((c) => c.name).join(', ') : undefined, checks, ...extra };
}

/** Intake policy refusals: each case must be refused with the expected HTTP status and error code. */
async function runRefusal(c, api, ctx) {
  const img = fixturePng(1024, 1024, 200_000 + 1024, ctx.seed++);
  const base = {
    tier: 'standard',
    contentType: 'image/png',
    contentLength: img.length,
    contentSha256: sha256Hex(img),
    recipientAddress: taprootAddress(randomXOnlyPubkey(), ctx.network),
    revealPubkey: randomXOnlyPubkey(),
    feeRate: Math.max(ctx.config.minFeeRate ?? 1, 2),
  };
  const other = ctx.network === 'mainnet' ? 'signet' : 'mainnet';
  const mutate = {
    wrong_network_recipient: (r) => ({ ...r, recipientAddress: taprootAddress(randomXOnlyPubkey(), other) }),
    fee_below_minimum: (r) => ({ ...r, feeRate: (ctx.config.minFeeRate ?? 1) / 2 }),
    content_type_not_allowed: (r) => ({ ...r, contentType: 'image/svg+xml' }),
    size_outside_tiers: (r) => ({ ...r, contentLength: 1000 }),
    invalid_reveal_pubkey: (r) => ({ ...r, revealPubkey: 'ff'.repeat(32) }),
  }[c.case];
  if (c.case === 'art_rejected') {
    // Declared metadata is fine; the bytes' header says the image is too small: rejected by the art review.
    const side = Math.max(1, (ctx.config.minDimensionPx ?? 2) - 1);
    const small = fixturePng(side, side, 200_000 + 2048, ctx.seed++);
    const created = await api.call('POST', '/v1/orders', { json: { ...base, contentLength: small.length, contentSha256: sha256Hex(small) } });
    if (created.status !== 201) return { name: `refusal:${c.case}`, ok: false, detail: { createStatus: created.status, error: created.body?.error } };
    const up = await api.call('PUT', `/v1/orders/${created.body.order.id}/content`, { bytes: small, token: created.body.orderToken });
    return { name: `refusal:${c.case}`, ok: up.body?.status === 'rejected', detail: { status: up.body?.status ?? up.status, reasons: up.body?.review?.reasons } };
  }
  if (!mutate) return { name: `refusal:${c.case}`, ok: false, detail: 'unknown refusal case' };
  const r = await api.call('POST', '/v1/orders', { json: mutate(base) });
  const ok = r.status === (c.expectStatus ?? 422) && (!c.expectCode || r.body?.error?.code === c.expectCode);
  return { name: `refusal:${c.case}`, ok, detail: { status: r.status, code: r.body?.error?.code } };
}

async function runManual(s, api, ctx) {
  const orderId = ctx.orders[s.name];
  if (!orderId) return { result: 'pending', reason: 'no order id yet (--orders / --order <scenario>=<id>)' };
  const expect = s.expect ?? { status: 'delivered' };
  const deadline = ctx.now() + (s.timeoutMinutes ?? ctx.timeoutMinutes) * 60_000;
  let order = null;
  for (;;) {
    const r = await api.call('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
    if (r.status !== 200) return { orderId, result: 'fail', reason: `GET order: HTTP ${r.status} ${r.body?.error?.code ?? ''}`.trim() };
    order = r.body;
    const done = order.status === expect.status || TERMINAL.has(order.status);
    if (done || !ctx.wait || ctx.now() >= deadline) break;
    await ctx.sleep(ctx.pollMs);
  }
  const path = (order.timeline ?? []).map((e) => e.status);
  const checks = [];
  checks.push({ name: 'final status', ok: order.status === expect.status, detail: { want: expect.status, got: order.status } });
  if (expect.rescued !== undefined) checks.push({ name: 'rescued', ok: order.rescued === expect.rescued, detail: { want: expect.rescued, got: order.rescued } });
  for (const st of expect.visits ?? []) checks.push({ name: `visited ${st}`, ok: path.includes(st) });
  if (expect.lane) checks.push({ name: 'lane', ok: order.quote?.lane === expect.lane, detail: { want: expect.lane, got: order.quote?.lane } });
  const reached = order.status === expect.status;
  const failed = checks.filter((c) => !c.ok);
  let result = failed.length ? 'fail' : 'pass';
  let reason = failed.length ? failed.map((c) => c.name).join(', ') : undefined;
  if (!reached && !TERMINAL.has(order.status) && !(ctx.wait && ctx.now() >= deadline)) {
    result = 'pending';
    reason = `in progress: ${order.status}`;
  } else if (!reached && ctx.wait && ctx.now() >= deadline) {
    reason = `timeout after ${s.timeoutMinutes ?? ctx.timeoutMinutes} min in ${order.status}`;
  }
  return {
    orderId,
    result,
    reason,
    finalStatus: order.status,
    rescued: order.rescued,
    lane: order.quote?.lane ?? s.lane ?? null,
    degentNumber: order.degentNumber ?? null,
    inscriptionId: order.inscriptionId ?? null,
    path,
    timings: timingsFromTimeline(order.timeline),
    checks,
  };
}

/**
 * Run the scenarios against `baseUrl` and return the report object (the CLI writes it to --out).
 * `fetch`, `now` and `sleep` are injectable so the runner is testable against the in-memory app.
 */
export async function runRehearsal(opts) {
  const {
    baseUrl,
    scenarios,
    fetch: fetchImpl = globalThis.fetch,
    orders = {},
    only = null,
    autoOnly = false,
    wait = false,
    pollMs = 15_000,
    timeoutMinutes = 180,
    recipient = null,
    allowMainnet = false,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const api = client(baseUrl, fetchImpl);
  const startedAt = new Date(now()).toISOString();
  const cfg = await api.call('GET', '/v1/config');
  if (cfg.status !== 200) throw new Error(`GET ${baseUrl}/v1/config: HTTP ${cfg.status}`);
  const health = await api.call('GET', '/v1/health');
  const fees = await api.call('GET', '/v1/fees');
  const ctx = {
    network: cfg.body.network,
    config: cfg.body,
    fees: fees.status === 200 ? fees.body : null,
    orders,
    recipient,
    allowMainnet,
    wait,
    pollMs,
    timeoutMinutes,
    now,
    sleep,
    seed: 11,
  };
  const results = [];
  for (const s of scenarios.scenarios) {
    if (only && !only.includes(s.name)) continue;
    if (autoOnly && s.mode !== 'auto') continue;
    const t0 = now();
    let r;
    try {
      r = s.mode === 'auto' ? await runAuto(s, api, ctx) : await runManual(s, api, ctx);
    } catch (e) {
      r = { result: 'fail', reason: `error: ${e instanceof Error ? e.message : String(e)}` };
    }
    results.push({
      name: s.name,
      mode: s.mode,
      wallet: s.wallet ?? null,
      device: s.device ?? null,
      lane: r.lane ?? s.lane ?? null,
      ...r,
      startedAt: new Date(t0).toISOString(),
      durationMs: now() - t0,
    });
  }
  const summary = { pass: 0, fail: 0, pending: 0 };
  for (const r of results) summary[r.result] = (summary[r.result] ?? 0) + 1;
  return {
    version: REPORT_VERSION,
    baseUrl,
    network: ctx.network,
    serviceVersion: health.body?.version ?? null,
    health: health.body?.status ?? null,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    summary,
    scenarios: results,
  };
}

// ------------------------------------------------------------------------------------------ CLI

export function parseArgs(argv) {
  const o = { orders: {}, out: 'rehearsal-report.json', scenarios: DEFAULT_SCENARIOS, pollMs: 15_000, timeoutMinutes: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--base-url') o.baseUrl = next();
    else if (a === '--scenarios') o.scenarios = next();
    else if (a === '--orders') Object.assign(o.orders, JSON.parse(readFileSync(next(), 'utf8')));
    else if (a === '--order') {
      const [k, v] = next().split('=');
      if (!k || !v) throw new Error('--order needs <scenario>=<order id>');
      o.orders[k] = v;
    } else if (a === '--only') o.only = next().split(',');
    else if (a === '--auto') o.autoOnly = true;
    else if (a === '--wait') o.wait = true;
    else if (a === '--poll-ms') o.pollMs = Number(next());
    else if (a === '--timeout-min') o.timeoutMinutes = Number(next());
    else if (a === '--recipient') o.recipient = next();
    else if (a === '--allow-mainnet') o.allowMainnet = true;
    else if (a === '--out') o.out = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const USAGE = `usage: node scripts/rehearsal/run.mjs --base-url <mint API base, e.g. http://127.0.0.1:8080/api>
  [--scenarios scripts/rehearsal/scenarios.json] [--only a,b] [--auto]
  [--orders orders.json | --order <scenario>=<order id> ...] [--wait] [--poll-ms 15000] [--timeout-min 180]
  [--recipient <taproot address for auto orders>] [--allow-mainnet] [--out rehearsal-report.json]`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help || !args.baseUrl) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const scenarios = JSON.parse(readFileSync(args.scenarios, 'utf8'));
  const report = await runRehearsal({ ...args, scenarios });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  for (const r of report.scenarios) console.log(`${r.result.padEnd(7)} ${r.name}${r.reason ? `  (${r.reason})` : ''}`);
  console.log(`\n${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.pending} pending -> ${args.out}`);
  process.exit(report.summary.fail ? 1 : 0);
}
