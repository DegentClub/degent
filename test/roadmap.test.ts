/**
 * roadmap.yaml is canonical and machine-readable: it must validate against schemas/roadmap.schema.json
 * (JSON Schema 2020-12), have no dangling depends_on, and every `verify` of an item in THIS repository must
 * name something that exists: a workspace package test file, a script file, or a root package.json script.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';

const root = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), 'utf8');

interface Item {
  id: string;
  repo: string | null;
  title: string;
  status: string;
  verify?: string;
  doc?: string;
  depends_on?: string[];
  owner_action?: boolean;
}
interface Roadmap {
  repos: Record<string, { url?: string; local?: boolean } | string[]>;
  phases: Array<{ id: string; items: Item[] }>;
}

const roadmap = load(read('roadmap.yaml')) as Roadmap;

/** Every item id that appears more than once, with where it appears ("p1.13 (p1, p1)"). */
function duplicateIds(r: Pick<Roadmap, 'phases'>): string[] {
  const seen = new Map<string, string[]>();
  for (const p of r.phases) for (const i of p.items) seen.set(i.id, [...(seen.get(i.id) ?? []), p.id]);
  return [...seen].filter(([, where]) => where.length > 1).map(([id, where]) => `${id} (${where.join(', ')})`);
}

/** Every depends_on entry that names no item ("p1.14 -> p1.99"). */
function danglingDepends(r: Pick<Roadmap, 'phases'>): string[] {
  const ids = new Set(r.phases.flatMap((p) => p.items.map((i) => i.id)));
  return r.phases.flatMap((p) => p.items.flatMap((i) => (i.depends_on ?? []).filter((d) => !ids.has(d)).map((d) => `${i.id} -> ${d}`)));
}
const items = roadmap.phases.flatMap((p) => p.items);
const localRepos = new Set(Object.entries(roadmap.repos).filter(([, r]) => !Array.isArray(r) && r.local).map(([k]) => k));

/** package name -> directory, from the pnpm workspace globs (products only; deps/scribbit is the platform). */
function workspacePackages(): Map<string, string> {
  const out = new Map<string, string>();
  const scan = (dir: string, depth: number) => {
    if (depth === 0) return;
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules') continue;
      const sub = `${dir}/${e.name}`;
      const pj = join(root, sub, 'package.json');
      if (existsSync(pj)) out.set((JSON.parse(readFileSync(pj, 'utf8')) as { name: string }).name, sub);
      else scan(sub, depth - 1);
    }
  };
  scan('products', 4);
  return out;
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      if (e.isDirectory()) rec(join(d, e.name));
      else if (/\.test\.tsx?$/.test(e.name)) out.push(e.name.replace(/\.test\.tsx?$/, ''));
    }
  };
  rec(join(root, dir, 'test'));
  rec(join(root, dir, 'src'));
  return out;
}

describe('roadmap.yaml', () => {
  it('validates against schemas/roadmap.schema.json', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(read('schemas/roadmap.schema.json')));
    expect(validate(roadmap), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('has unique item ids across all phases (merged branches must renumber, not collide)', () => {
    expect(duplicateIds(roadmap)).toEqual([]);
  });

  it('has no depends_on pointing at an unknown id', () => {
    expect(danglingDepends(roadmap)).toEqual([]);
  });

  it('names repos that exist in the repos map', () => {
    for (const i of items) if (i.repo !== null) expect(Object.keys(roadmap.repos), i.id).toContain(i.repo);
    expect(localRepos.has('degent')).toBe(true);
  });

  it('every verify of a local item names an existing test file, script file or root script', () => {
    const pkgs = workspacePackages();
    const rootScripts = Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts);
    const problems: string[] = [];
    for (const i of items) {
      if (!i.verify || i.repo === null || !localRepos.has(i.repo)) continue;
      const v = i.verify.trim();
      let m: RegExpExecArray | null;
      if ((m = /^pnpm --filter (\S+) test -- (.+)$/.exec(v))) {
        const dir = pkgs.get(m[1]!);
        if (!dir) {
          problems.push(`${i.id}: unknown package ${m[1]}`);
          continue;
        }
        const files = testFiles(dir);
        for (const name of m[2]!.split(/\s+/)) if (!files.includes(name)) problems.push(`${i.id}: no test file named ${name} in ${dir}`);
      } else if ((m = /^node (\S+)/.exec(v))) {
        if (!existsSync(join(root, m[1]!))) problems.push(`${i.id}: script ${m[1]} does not exist`);
      } else if ((m = /^pnpm (?:run )?([\w:.-]+)$/.exec(v))) {
        if (!rootScripts.includes(m[1]!)) problems.push(`${i.id}: no root script ${m[1]}`);
      } else {
        problems.push(`${i.id}: unrecognised verify form "${v}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('docs referenced by items exist', () => {
    for (const i of items) if (i.doc) expect(existsSync(join(root, i.doc)), `${i.id}: ${i.doc}`).toBe(true);
  });

  it('done items in this repository are proven by a verify or a doc', () => {
    for (const i of items) if (i.status === 'done' && i.repo && localRepos.has(i.repo)) expect(Boolean(i.verify || i.doc), i.id).toBe(true);
  });
});

describe('roadmap id checks (fixtures)', () => {
  const item = (id: string, depends_on?: string[]): Item => ({ id, repo: 'degent', title: id, status: 'todo', ...(depends_on ? { depends_on } : {}) });
  const fixture = (phases: Record<string, Item[]>): Pick<Roadmap, 'phases'> => ({ phases: Object.entries(phases).map(([id, items]) => ({ id, items })) });

  it('flags an id duplicated within a phase and across phases', () => {
    const r = fixture({ p1: [item('p1.13'), item('p1.14'), item('p1.13')], p2: [item('p2.1'), item('p1.14')] });
    expect(duplicateIds(r)).toEqual(['p1.13 (p1, p1)', 'p1.14 (p1, p2)']);
  });

  it('flags depends_on naming an unknown id', () => {
    const r = fixture({ p1: [item('p1.1'), item('p1.2', ['p1.1', 'p1.99'])], p2: [item('p2.1', ['p3.4'])] });
    expect(danglingDepends(r)).toEqual(['p1.2 -> p1.99', 'p2.1 -> p3.4']);
  });

  it('accepts unique ids with resolvable depends_on', () => {
    const r = fixture({ p1: [item('p1.1'), item('p1.2', ['p1.1'])], p2: [item('p2.1', ['p1.2'])] });
    expect(duplicateIds(r)).toEqual([]);
    expect(danglingDepends(r)).toEqual([]);
  });
});

describe('schemas/register.schema.json', () => {
  it('accepts a Gallery member and a child, rejects a bad inscription id', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(read('schemas/register.schema.json')));
    const id = `${'a'.repeat(64)}i0`;
    expect(validate({ n: 1, id, via: 'gallery', bytes: 355973, sat: 969669989966969 })).toBe(true);
    expect(validate({ n: 4113, id, via: 'child', owner: 'bc1p', height: 912345 })).toBe(true);
    expect(validate({ n: 0, id, via: 'child' })).toBe(false);
    expect(validate({ n: 1, id: 'nope', via: 'gallery' })).toBe(false);
    expect(validate({ n: 1, id, via: 'vote' })).toBe(false);
  });
});
