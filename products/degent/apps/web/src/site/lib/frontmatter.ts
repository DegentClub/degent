/**
 * A tiny front-matter parser for the blog's markdown files (build time via import.meta.glob, no
 * network). Supports the subset we write: a leading `---` block of `key: value` lines, values as
 * strings (optionally quoted), booleans, numbers, and `[a, b]` string lists.
 */

export type FrontValue = string | number | boolean | string[];

export interface Parsed {
  data: Record<string, FrontValue>;
  body: string;
}

export class FrontMatterError extends Error {}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return v;
}

function value(raw: string): FrontValue {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => unquote(x.trim())) : [];
  }
  return unquote(v);
}

export function parseFrontMatter(source: string): Parsed {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) throw new FrontMatterError('unterminated front matter');
  const head = text.slice(4, end);
  const after = text.slice(end + 4);
  const body = after.startsWith('\n') ? after.slice(1) : after;
  const data: Record<string, FrontValue> = {};
  for (const [i, line] of head.split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new FrontMatterError(`front matter line ${i + 1}: expected "key: value"`);
    data[m[1]!] = value(m[2]!);
  }
  return { data, body };
}

export interface PostMeta {
  slug: string;
  title: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  cover: string;
  excerpt: string;
  draft: boolean;
  tags: string[];
}

export interface Post extends PostMeta {
  body: string;
}

/** Validate a post's front matter. `slug` defaults to the file name. */
export function toPost(fileSlug: string, source: string): Post {
  const { data, body } = parseFrontMatter(source);
  const str = (k: string): string => {
    const v = data[k];
    if (typeof v !== 'string' || !v.trim()) throw new FrontMatterError(`${fileSlug}: "${k}" is required`);
    return v.trim();
  };
  const date = str('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new FrontMatterError(`${fileSlug}: "date" must be YYYY-MM-DD`);
  const slug = typeof data.slug === 'string' && data.slug ? data.slug : fileSlug;
  return {
    slug,
    title: str('title'),
    date,
    cover: typeof data.cover === 'string' ? data.cover : '',
    excerpt: typeof data.excerpt === 'string' ? data.excerpt : '',
    draft: data.draft === true,
    tags: Array.isArray(data.tags) ? data.tags : [],
    body,
  };
}
