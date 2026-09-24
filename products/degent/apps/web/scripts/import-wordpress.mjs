#!/usr/bin/env node
/**
 * Import the degent.club WordPress posts into src/content/blog/*.md. Reads a LOCAL export: it never
 * calls the network. Produce the export once, by hand, from the live site:
 *
 *   curl -s 'https://degent.club/wp-json/wp/v2/posts?per_page=100&_embed=1' > wp-posts.json
 *
 * then run:
 *
 *   node scripts/import-wordpress.mjs wp-posts.json [--out src/content/blog] [--force]
 *
 * Each post keeps its WordPress slug (so /blog/<slug> URLs survive), its date, title, excerpt and
 * featured image URL (`cover`). The HTML body is converted to the small markdown subset the site
 * renders (headings, paragraphs, lists, quotes, links, images, bold/italic, code). Anything else
 * (embeds, shortcodes, scripts) is dropped; review the output before committing. Existing files are
 * not overwritten without --force. Only `status: publish` posts are imported.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const attr = (tag, name) => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
};

const safe = (u) => (/^(https?:\/\/|\/(?!\/)|mailto:)/i.test(u) ? u : '');

/** HTML (WordPress `content.rendered`) → the markdown subset of src/site/lib/markdown.tsx. */
export function htmlToMarkdown(html) {
  let s = html.replace(/\r\n?/g, '\n');
  s = s.replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\[\/?[a-z_]+[^\]]*\]/gi, ''); // shortcodes
  s = s.replace(/<img\b[^>]*>/gi, (t) => {
    const src = safe(attr(t, 'src'));
    return src ? `\n\n![${attr(t, 'alt').replace(/[[\]]/g, '')}](${src})\n\n` : '';
  });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a, text) => {
    const href = safe(attr(a, 'href'));
    const t = text.replace(/<[^>]+>/g, '').trim();
    return href && t ? `[${t}](${href})` : t;
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${'#'.repeat(Math.min(3, Math.max(1, Number(l) - 1)))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) =>
    `\n\n${t.replace(/<\/?p[^>]*>/gi, '\n').trim().split('\n').filter((l) => l.trim()).map((l) => `> ${l.trim()}`).join('\n')}\n\n`,
  );
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, t) => {
    let i = 0;
    return `\n\n${t.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, x) => `${++i}. ${x.replace(/<[^>]+>/g, '').trim()}\n`).replace(/<[^>]+>/g, '')}\n`;
  });
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, t) => `\n\n${t.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, x) => `- ${x.replace(/<[^>]+>/g, '').trim()}\n`).replace(/<[^>]+>/g, '')}\n`);
  s = s.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>|<p\b[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}

const yamlString = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
const text = (html) => decodeEntities(String(html ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** One WordPress post object → { slug, markdown file contents }. */
export function postToMarkdown(p) {
  const slug = String(p.slug ?? '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) throw new Error(`post ${p.id}: unusable slug "${p.slug}"`);
  const title = text(p.title?.rendered ?? p.title);
  const date = String(p.date ?? '').slice(0, 10);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`post ${slug}: missing title or date`);
  const media = p._embedded?.['wp:featuredmedia']?.[0];
  const cover = safe(media?.source_url ?? p.jetpack_featured_media_url ?? '');
  const excerpt = text(p.excerpt?.rendered ?? '').replace(/\s*\[…\]$|\s*\[&hellip;\]$/, '');
  const head = ['---', `title: ${yamlString(title)}`, `date: ${date}`, `slug: ${slug}`, cover ? `cover: ${yamlString(cover)}` : null, excerpt ? `excerpt: ${yamlString(excerpt)}` : null, 'draft: false', '---', '']
    .filter((l) => l !== null)
    .join('\n');
  return { slug, file: `${head}${htmlToMarkdown(p.content?.rendered ?? '')}` };
}

function main(argv) {
  const args = argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('usage: node scripts/import-wordpress.mjs <wp-posts.json> [--out src/content/blog] [--force]');
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const outIdx = args.indexOf('--out');
  const out = resolve(outIdx >= 0 ? args[outIdx + 1] : join(here, '..', 'src', 'content', 'blog'));
  const force = args.includes('--force');
  const posts = JSON.parse(readFileSync(input, 'utf8'));
  if (!Array.isArray(posts)) throw new Error('expected the wp-json/wp/v2/posts array');
  mkdirSync(out, { recursive: true });
  let written = 0;
  for (const p of posts) {
    if (p.status && p.status !== 'publish') continue;
    const { slug, file } = postToMarkdown(p);
    const target = join(out, `${slug}.md`);
    if (existsSync(target) && !force) {
      console.warn(`skip ${slug} (exists; --force to overwrite)`);
      continue;
    }
    writeFileSync(target, file);
    written++;
    console.log(`wrote ${target}`);
  }
  console.log(`${written} post(s) imported. Delete the placeholder drafts (go-big-or-go-home.md, club-update.md) once the real posts are in.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
