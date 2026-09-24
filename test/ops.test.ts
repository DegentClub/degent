/**
 * products/degent/ops: the Grafana dashboard and the Loki alert rules are built only from degent-mint's JSON log
 * lines. This checks that every `msg` and field they reference still exists in the service code, and that every
 * runbook link points at a heading that exists in RUNBOOK.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const root = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const MINT = 'products/degent/services/mint';

/** The code that writes the log lines the ops files use. */
const SOURCES = [
  'src/application/logger.ts',
  'src/application/order-service.ts',
  'src/worker.ts',
  'src/adapters/in-memory-policy-signer.ts',
].map((f) => read(`${MINT}/${f}`));
const code = SOURCES.join('\n');

/** The order statuses (mint-sdk ORDER_STATUSES), for per-status gauge fields `counts_<status>` / `oldestSeconds_<status>`. */
const sdkTypes = read('products/degent/packages/mint-sdk/src/types.ts');
const ORDER_STATUSES = [...(/ORDER_STATUSES = \[([^\]]*)\]/.exec(sdkTypes)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
/** Object-valued fields of `mint gauges`, keyed by status; LogQL `| json` flattens them to `<field>_<status>`. */
const PER_STATUS_FIELDS = ['counts', 'oldestSeconds'];

interface Panel {
  type: string;
  title: string;
  targets?: Array<{ expr: string }>;
  links?: Array<{ url: string }>;
}
interface Rule {
  alert: string;
  expr: string;
  labels: Record<string, string>;
  annotations: { summary: string; runbook_url: string };
}

const dashboard = JSON.parse(read('products/degent/ops/grafana/degent-mint.dashboard.json')) as { panels: Panel[]; links: Array<{ url: string }> };
const rules = load(read('products/degent/ops/alerts/degent-mint.rules.yaml')) as { groups: Array<{ name: string; rules: Rule[] }> };
const panels = dashboard.panels.filter((p) => p.type !== 'row');
const allRules = rules.groups.flatMap((g) => g.rules);
const exprs = [...panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr)), ...allRules.map((r) => r.expr)];

/** Labels LogQL creates itself or that the shipper adds; everything else must come from the JSON line. */
const NOT_FROM_JSON = new Set(['job']);

/** `msg="…"` values and field names a LogQL expression uses after `| json`. */
function references(expr: string): { msgs: string[]; fields: string[] } {
  const msgs = [...expr.matchAll(/\bmsg\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
  const fields = new Set<string>();
  for (const m of expr.matchAll(/\|\s*unwrap\s+(\w+)/g)) fields.add(m[1]!);
  for (const m of expr.matchAll(/\|\s*(\w+)\s*(?:=|!=|==|>=|<=|>|<|=~|!~)\s*[-"\d]/g)) fields.add(m[1]!);
  for (const m of expr.matchAll(/\bby\s*\(([^)]*)\)/g)) for (const f of m[1]!.split(',')) if (f.trim()) fields.add(f.trim());
  for (const m of expr.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) fields.add(m[1]!);
  fields.delete('msg');
  for (const f of NOT_FROM_JSON) fields.delete(f);
  return { msgs, fields: [...fields] };
}

/** GitHub heading anchors of RUNBOOK.md. */
function anchors(md: string): Set<string> {
  return new Set(
    [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
      m[1]!
        .trim()
        .toLowerCase()
        .replace(/[^\w\- ]/g, '')
        .replace(/ /g, '-'),
    ),
  );
}
const runbookAnchors = anchors(read(`${MINT}/RUNBOOK.md`));

describe('ops dashboard + alerts reference real log output', () => {
  it('parses: dashboard panels have queries, rules have expr, severity, summary and runbook', () => {
    expect(panels.length).toBeGreaterThanOrEqual(10);
    for (const p of panels) expect(p.targets?.length, p.title).toBeGreaterThan(0);
    expect(allRules.length).toBeGreaterThanOrEqual(10);
    for (const r of allRules) {
      expect(r.expr, r.alert).toMatch(/\{job="degent-mint"\}/);
      expect(['warning', 'critical'], r.alert).toContain(r.labels.severity);
      expect(r.annotations.summary.length, r.alert).toBeGreaterThan(10);
      expect(r.annotations.runbook_url, r.alert).toMatch(/RUNBOOK\.md#/);
    }
    expect(new Set(allRules.map((r) => r.alert)).size).toBe(allRules.length);
  });

  it('covers the required views', () => {
    const titles = panels.map((p) => p.title).join(' | ');
    for (const t of ['Orders by status', 'Time in status', 'Pay → delivered', 'member_review backlog', 'Oldest member_review', 'rescue_available', 'broadcast failures', 'Parent health', 'Art review verdicts', 'Advisory rule fails'])
      expect(titles).toContain(t);
  });

  it('every msg they select is a string literal the service logs', () => {
    const msgs = new Set(exprs.flatMap((e) => references(e).msgs));
    expect(msgs.size).toBeGreaterThanOrEqual(6);
    const missing = [...msgs].filter((m) => !code.includes(`'${m}'`));
    expect(missing).toEqual([]);
  });

  it('every field they filter, unwrap or group by is written by the logger or the service', () => {
    const fields = new Set(exprs.flatMap((e) => references(e).fields));
    for (const f of ['to', 'from', 'lane', 'msInPreviousStatus', 'payToDeliveredMs', 'memberReview', 'memberReviewOldestAgeSeconds', 'rescueAvailable', 'parentKnown', 'approved', 'square', 'advisoryFails', 'retryable', 'via', 'oldestSeconds_revealed'])
      expect(fields.has(f), f).toBe(true);
    // A field exists when the code writes it as an object key (`field:`, `field,` shorthand) or it is a logger base field.
    const key = (f: string) => new RegExp(`[{,\\s]${f}\\s*[:,}]`).test(code) || new RegExp(`\\b${f}\\b`).test(SOURCES[0]!);
    // Or it is a per-status gauge (`oldestSeconds_revealed`): a written object field + `_` + a real order status.
    const perStatus = (f: string) => PER_STATUS_FIELDS.some((p) => f.startsWith(`${p}_`) && key(p) && ORDER_STATUSES.includes(f.slice(p.length + 1)));
    expect([...fields].filter((f) => !key(f) && !perStatus(f))).toEqual([]);
  });

  it('per-status gauge fields name real, non-terminal order statuses', () => {
    expect(ORDER_STATUSES).toContain('revealed');
    expect(ORDER_STATUSES.length).toBeGreaterThanOrEqual(15);
    const fields = new Set(exprs.flatMap((e) => references(e).fields));
    const perStatus = [...fields].filter((f) => PER_STATUS_FIELDS.some((p) => f.startsWith(`${p}_`)));
    expect(perStatus.length).toBeGreaterThanOrEqual(7);
    for (const f of perStatus) expect(['rejected', 'expired', 'failed', 'delivered'], f).not.toContain(f.slice(f.indexOf('_') + 1));
  });

  it('every runbook link points at an existing RUNBOOK.md heading', () => {
    const urls = [...allRules.map((r) => r.annotations.runbook_url), ...panels.flatMap((p) => (p.links ?? []).map((l) => l.url))];
    expect(urls.length).toBeGreaterThan(allRules.length);
    const bad = urls.map((u) => u.split('#')[1] ?? '').filter((a) => a && !runbookAnchors.has(a));
    expect(bad).toEqual([]);
  });
});
