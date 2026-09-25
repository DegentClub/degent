/**
 * docs/security/findings.json is machine-readable and honest: it validates against
 * schemas/security-findings.schema.json, ids are unique, every `fixed` finding names a regression test file
 * that exists and a commit in this repository's history, every open/accepted finding is tracked by a roadmap
 * item, superseded ones say why, and docs/SECURITY.md lists every finding id.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { load } from 'js-yaml';

const root = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), 'utf8');

interface Finding {
  id: string;
  component: string;
  severity: string;
  title: string;
  status: 'fixed' | 'accepted' | 'open' | 'platform' | 'superseded';
  test: string | null;
  commit: string | null;
  note?: string;
  roadmap?: string;
}

const findings = JSON.parse(read('docs/security/findings.json')) as Finding[];
const schema = JSON.parse(read('schemas/security-findings.schema.json')) as object;
const roadmapIds = new Set(
  (load(read('roadmap.yaml')) as { phases: Array<{ items: Array<{ id: string }> }> }).phases.flatMap((p) => p.items.map((i) => i.id)),
);

describe('docs/security/findings.json', () => {
  it('validates against schemas/security-findings.schema.json', () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    const ok = validate(findings);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the schema rejects a fixed finding without a test, an open one without a roadmap item, an unknown status', () => {
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const base = { id: 'DGT-SEC-999', component: 'mint', severity: 'low', title: 'a finding title long enough', test: null, commit: null };
    expect(validate([{ ...base, status: 'fixed' }])).toBe(false);
    expect(validate([{ ...base, status: 'open' }])).toBe(false);
    expect(validate([{ ...base, status: 'wontfix' }])).toBe(false);
    expect(validate([{ ...base, status: 'superseded' }])).toBe(false);
    expect(validate([{ ...base, status: 'open', roadmap: 'p0.21' }])).toBe(true);
  });

  it('ids are unique', () => {
    const ids = findings.map((f) => f.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('every fixed finding names an existing regression test file and a commit in this history', () => {
    // A shallow checkout (CI often fetches depth 1) cannot see older commit objects, so only
    // verify the referenced commit exists when the full history is present. The test file must
    // always exist.
    let shallow = true;
    try {
      shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root }).toString().trim() === 'true';
    } catch {
      shallow = true;
    }
    for (const f of findings.filter((x) => x.status === 'fixed')) {
      expect(f.test, f.id).toMatch(/\.test\.tsx?$/);
      expect(existsSync(join(root, f.test!)), `${f.id}: ${f.test}`).toBe(true);
      if (!shallow)
        expect(() => execFileSync('git', ['cat-file', '-e', `${f.commit}^{commit}`], { cwd: root, stdio: 'ignore' }), `${f.id}: ${f.commit}`).not.toThrow();
    }
  });

  it('open and accepted findings are tracked by an existing roadmap item; superseded ones say why', () => {
    for (const f of findings.filter((x) => x.status === 'open' || x.status === 'accepted')) expect(roadmapIds.has(f.roadmap!), `${f.id} -> ${f.roadmap}`).toBe(true);
    for (const f of findings.filter((x) => x.status === 'superseded')) expect(f.note, f.id).toMatch(/ADR-0010/);
  });

  it('no medium-or-higher finding in this repository is left open', () => {
    const open = findings.filter((f) => f.status === 'open' && ['critical', 'high', 'medium'].includes(f.severity));
    expect(open.map((f) => f.id)).toEqual([]);
  });

  it('docs/SECURITY.md lists every finding id', () => {
    const doc = read('docs/SECURITY.md');
    expect(findings.filter((f) => !doc.includes(f.id)).map((f) => f.id)).toEqual([]);
  });
});
