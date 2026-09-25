/**
 * A deliberately small Markdown renderer for the in-repo blog (no dependency, no HTML injection):
 * front matter, ATX headings, paragraphs, ordered/unordered lists, blockquotes, fenced code, images,
 * thematic breaks, and inline `code`, **bold**, *italic*, [links](url). Raw HTML is shown as text.
 * Only http(s), mailto, relative and hash URLs are linked.
 */
import { Fragment, type ReactNode } from 'react';

export interface FrontMatter {
  [key: string]: string;
}

/** Split `---\nkey: value\n---\n body`; values may be quoted. */
export function parseFrontMatter(raw: string): { meta: FrontMatter; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: FrontMatter = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]!] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

export function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null;
  return u;
}

let keySeq = 0;
const k = () => `md${++keySeq}`;

/** Inline spans. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k()}>{t.slice(1, -1)}</code>);
    else if (m[2]) {
      const mm = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(t)!;
      const src = safeUrl(mm[2]!);
      out.push(src ? <img key={k()} src={src} alt={mm[1]!} loading="lazy" /> : mm[1]!);
    } else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      const href = safeUrl(mm[2]!);
      const external = href ? /^https?:/i.test(href) : false;
      out.push(
        href ? (
          <a key={k()} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            {renderInline(mm[1]!)}
          </a>
        ) : (
          mm[1]!
        ),
      );
    } else if (m[4]) out.push(<strong key={k()}>{renderInline(t.slice(2, -2))}</strong>);
    else if (m[5]) out.push(<em key={k()}>{renderInline(t.slice(1, -1))}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Block structure → React nodes. Headings are shifted down one level (the page owns the h1). */
export function renderMarkdown(md: string): ReactNode {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || l.trim() === '';
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={k()}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length + 1);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={k()}>{renderInline(heading[2]!.replace(/\s+#+\s*$/, ''))}</Tag>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={k()} />);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k()}>{renderMarkdown(body.join('\n'))}</blockquote>);
      continue;
    }
    const ul = /^\s*[-*+]\s+/;
    const ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]!) || (!isBlank(lines[i]) && /^\s{2,}/.test(lines[i]!) && items.length > 0))) {
        const l = lines[i++]!;
        if (re.test(l)) items.push(l.replace(re, ''));
        else items[items.length - 1] += ` ${l.trim()}`;
      }
      const lis = items.map((t) => <li key={k()}>{renderInline(t)}</li>);
      blocks.push(ordered ? <ol key={k()}>{lis}</ol> : <ul key={k()}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    if (para.length === 0) {
      // A line no block rule consumed: render it as its own paragraph.
      para.push(lines[i++]!.trim());
    }
    blocks.push(<p key={k()}>{renderInline(para.join(' '))}</p>);
  }
  return <Fragment>{blocks}</Fragment>;
}
