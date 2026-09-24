#!/usr/bin/env node
// Validates roadmap.json against the structural rules of schemas/roadmap.schema.json without a
// JSON Schema library (the root workspace deliberately has no runtime dependencies). The schema
// stays the canonical description; this checker mirrors its required fields, enums and patterns
// and adds the cross-item rules (unique ids, depends_on resolves, phase ids sequential).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const file = process.argv[2] ?? resolve(root, 'roadmap.json');
const errors = [];
const err = (path, msg) => errors.push(`${path}: ${msg}`);

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`roadmap: cannot read ${file}: ${e.message}`);
  process.exit(2);
}

const STATUS = ['todo', 'in_progress', 'done', 'blocked', 'deferred'];
const isStr = (v) => typeof v === 'string' && v.length > 0;

if (doc.version !== 1) err('version', 'must be 1');
if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.updated ?? '')) err('updated', 'must be YYYY-MM-DD');
for (const k of ['text', 'measure', 'reproduce']) if (!isStr(doc.claim?.[k])) err(`claim.${k}`, 'required string');
if (!doc.repos || typeof doc.repos !== 'object') err('repos', 'required object');
if (!Array.isArray(doc.phases) || doc.phases.length === 0) err('phases', 'required non-empty array');

const ids = new Set();
const deps = [];
(doc.phases ?? []).forEach((phase, i) => {
  const p = `phases[${i}]`;
  if (!/^p\d+$/.test(phase.id ?? '')) err(`${p}.id`, 'must match ^p[0-9]+$');
  if (phase.id !== `p${i}`) err(`${p}.id`, `phases must be sequential; expected p${i}`);
  if (!isStr(phase.name)) err(`${p}.name`, 'required');
  if (!isStr(phase.exit)) err(`${p}.exit`, 'required');
  if (!Array.isArray(phase.items) || phase.items.length === 0) err(`${p}.items`, 'required non-empty array');
  (phase.items ?? []).forEach((item, j) => {
    const q = `${p}.items[${j}]`;
    if (!new RegExp(`^${phase.id}\\.\\d+$`).test(item.id ?? '')) err(`${q}.id`, `must match ^${phase.id}\\.[0-9]+$`);
    if (ids.has(item.id)) err(`${q}.id`, `duplicate id ${item.id}`);
    ids.add(item.id);
    if (!isStr(item.title)) err(`${q}.title`, 'required');
    if (!STATUS.includes(item.status)) err(`${q}.status`, `must be one of ${STATUS.join('|')}`);
    if (item.repo != null && !(item.repo in (doc.repos ?? {}))) err(`${q}.repo`, `unknown repo ${item.repo}`);
    if (item.status === 'blocked' && !isStr(item.blocker)) err(`${q}.blocker`, 'blocked items name their blocker');
    if (item.owner_action != null && typeof item.owner_action !== 'boolean') err(`${q}.owner_action`, 'boolean');
    for (const d of item.depends_on ?? []) deps.push([q, item.id, d]);
  });
});
for (const [q, id, d] of deps) {
  if (!ids.has(d)) err(`${q}.depends_on`, `unknown item ${d}`);
  if (d === id) err(`${q}.depends_on`, 'an item cannot depend on itself');
}
// A done item may not depend on an item that is not done.
const byId = new Map();
for (const phase of doc.phases ?? []) for (const item of phase.items ?? []) byId.set(item.id, item);
for (const [q, id, d] of deps) {
  const item = byId.get(id);
  const dep = byId.get(d);
  if (item?.status === 'done' && dep && dep.status !== 'done') err(`${q}.depends_on`, `${id} is done but ${d} is ${dep.status}`);
}

const counts = Object.fromEntries(STATUS.map((s) => [s, 0]));
for (const item of byId.values()) counts[item.status] = (counts[item.status] ?? 0) + 1;

if (errors.length) {
  for (const e of errors) console.error(`error ${e}`);
  console.error(`roadmap: FAILED - ${errors.length} error(s)`);
  process.exit(1);
}
console.log(
  `roadmap: ok - ${doc.phases.length} phases, ${byId.size} items (${STATUS.map((s) => `${s} ${counts[s]}`).join(', ')})`,
);
