#!/usr/bin/env node
/**
 * register-batch — emit a Register update for the owner to inscribe as a child of the Club parent
 * (docs/REGISTER.md §1.3, ADR-0005 §4): every order the members approved since `--since`, with its
 * Degent number, inscription id and the approver signatures (BIP-322 over the vote statement), so the
 * on-chain record carries the proof of admission.
 *
 * Usage:
 *   node scripts/register-batch.mjs --db <DATABASE_PATH> [--since <degent number>] [--only-delivered]
 *                                    [--parent <parent inscription id>] [--out register-update.json]
 *   node scripts/register-batch.mjs --help
 *
 * Reads the mint service's sqlite database directly (orders + votes tables, read-only). Output:
 *   { version: 1, kind: "degent.club/register-update", parent, generatedAt, members: [
 *       { n, id, via: "child", bytes, height, owner, orderId, approvedAt, votes: [{ degent, vote, signature, message, at }] } ] }
 * Each member entry also validates against schemas/register.schema.json (n, id, via, bytes, height, owner).
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] === undefined || arr[i + 1].startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

if (args.help || !args.db) {
  console.log(`usage: node scripts/register-batch.mjs --db <DATABASE_PATH> [--since <degent number>] [--only-delivered] [--parent <id>] [--out <file>]

Emits the newly approved members {n, id, votes:[{degent, signature}]} as JSON for the owner to inscribe as a
child of the Club parent (docs/REGISTER.md). --since excludes members with n <= the given number (the last
inscribed update). --only-delivered keeps orders whose child already landed on chain (default: approved orders
with a known inscription id).`);
  process.exit(args.help ? 0 : 2);
}

const since = args.since ? Number(args.since) : 0;
const db = new DatabaseSync(String(args.db), { readOnly: true });
const rows = db.prepare('SELECT data FROM orders ORDER BY created_at, id').all().map((r) => JSON.parse(r.data));
const voteStmt = db.prepare('SELECT voter_degent, vote, signature, message, at FROM votes WHERE order_id = ? ORDER BY at');

const members = [];
for (const o of rows) {
  if (o.degentNumber === null || o.degentNumber === undefined || o.degentNumber <= since) continue;
  if (o.rescued || !o.inscriptionId) continue;
  if (args['only-delivered'] && o.status !== 'delivered') continue;
  const confirmed = (o.timeline ?? []).find((e) => e.status === 'confirmed');
  const height = confirmed ? Number((/^block (\d+)$/.exec(confirmed.detail ?? '') ?? [])[1] ?? NaN) : NaN;
  const votes = voteStmt.all(o.id).map((v) => ({ degent: Number(v.voter_degent), vote: v.vote, signature: v.signature, message: v.message, at: v.at }));
  members.push({
    n: o.degentNumber,
    id: o.inscriptionId,
    via: 'child',
    bytes: o.contentLength,
    ...(Number.isFinite(height) ? { height } : {}),
    owner: o.recipientAddress,
    orderId: o.id,
    approvedAt: o.approvedAt ?? null,
    status: o.status,
    votes,
  });
}
members.sort((a, b) => a.n - b.n);

for (const m of members) {
  if (!/^[0-9a-f]{64}i\d+$/.test(m.id)) throw new Error(`#${m.n}: bad inscription id`);
  if (!m.votes.some((v) => v.vote === 'approve')) throw new Error(`#${m.n}: no approval votes recorded`);
}

const update = {
  version: 1,
  kind: 'degent.club/register-update',
  parent: args.parent ?? null,
  generatedAt: new Date().toISOString(),
  since,
  count: members.length,
  members,
};
const json = `${JSON.stringify(update, null, 2)}\n`;
if (args.out) {
  writeFileSync(String(args.out), json);
  console.error(`wrote ${args.out}: ${members.length} members${members.length ? ` (#${members[0].n}..#${members.at(-1).n})` : ''}`);
} else {
  process.stdout.write(json);
}
