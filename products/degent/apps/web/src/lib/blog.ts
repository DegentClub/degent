/**
 * The blog's content source (site spec "Blog": the rebuild needs a content source; builder decides).
 * Decision: Markdown files in the repo, `content/blog/*.md`, bundled at build time with Vite's
 * `import.meta.glob(..., { query: '?raw', eager: true })`. No CMS, no runtime fetch, reviewed in PRs.
 *
 * Front matter: `title` (required), `date` (YYYY-MM-DD, required), `slug` (defaults to the file name;
 * KEEP the WordPress slug when porting a post so `/blog/<slug>/` maps to `#/blog/<slug>`), `excerpt`,
 * `cover` (image URL), `author`, `example: true` (renders an "Example post" badge).
 */
import { parseFrontMatter } from './markdown';

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  excerpt: string | null;
  cover: string | null;
  author: string | null;
  example: boolean;
  body: string;
  file: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

export function parsePost(file: string, raw: string): BlogPost | null {
  const { meta, body } = parseFrontMatter(raw);
  const base = file.split('/').pop()!.replace(/\.md$/, '');
  const slug = (meta.slug ?? base).toLowerCase();
  if (!meta.title || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? '') || !SLUG.test(slug)) return null;
  return {
    slug,
    title: meta.title,
    date: meta.date!,
    excerpt: meta.excerpt ?? null,
    cover: meta.cover ?? null,
    author: meta.author ?? null,
    example: meta.example === 'true',
    body,
    file,
  };
}

/** Newest first; invalid files are skipped (and reported in dev). */
export function collectPosts(files: Record<string, string>): BlogPost[] {
  const posts: BlogPost[] = [];
  for (const [file, raw] of Object.entries(files)) {
    const p = parsePost(file, raw);
    if (p) posts.push(p);
    else if (import.meta.env?.DEV) console.warn(`blog: skipped ${file} (needs title, date YYYY-MM-DD and a valid slug)`);
  }
  return posts.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : a.date < b.date ? 1 : -1));
}

const files = import.meta.glob('../../content/blog/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const POSTS: readonly BlogPost[] = collectPosts(files);

export function findPost(slug: string): BlogPost | null {
  return POSTS.find((p) => p.slug === slug) ?? null;
}
