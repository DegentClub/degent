/**
 * Blog content: markdown files in `src/content/blog/*.md`, bundled at build time by Vite's
 * `import.meta.glob` (no network). Drafts (`draft: true`) are shown only in demo mode. The WordPress
 * posts are imported into this folder by `scripts/import-wordpress.mjs` (see README "Blog").
 */
import { toPost, type Post } from './lib/frontmatter';

const files = import.meta.glob('../content/blog/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

let all: Post[] | null = null;

export function allPosts(): Post[] {
  if (!all) {
    all = Object.entries(files)
      .map(([path, src]) => toPost(path.split('/').pop()!.replace(/\.md$/, ''), src))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));
  }
  return all;
}

export function visiblePosts(demo: boolean): Post[] {
  return allPosts().filter((p) => demo || !p.draft);
}

export function findPost(slug: string, demo: boolean): Post | null {
  return visiblePosts(demo).find((p) => p.slug === slug) ?? null;
}
