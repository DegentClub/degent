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

  it('has unique ids and no dangling depends_on', () => {
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const dangling = items.flatMap((i) => (i.depends_on ?? []).filter((d) => !ids.includes(d)).map((d) => `${i.id} -> ${d}`));
    expect(dangling).toEqual([]);
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
