/**
 * A deliberately small markdown renderer for blog posts, producing React elements (never raw HTML,
 * so imported content cannot inject markup or scripts). Supported: #–#### headings, paragraphs,
 * `-`/`*` and `1.` lists, `>` quotes, fenced code, `---` rules, images, links (http, https, mailto,
 * site-relative), **bold**, *italic*, `code`.
 */
import type { ReactNode } from 'react';
import { APP_BASE, withBase } from '../router';

const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

/** A vetted URL; site-relative ones (`/club`) get the build's base path (`/degent/club` on GitHub Pages). */
export function safeUrl(u: string, base: string = APP_BASE): string | null {
  const t = u.trim();
  return SAFE_URL.test(t) ? withBase(t, base) : null;
}

let keySeq = 0;
const k = () => `md${++keySeq}`;

/** Inline spans: images, links, bold, italic, code. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const src = safeUrl(m[3]!);
      out.push(src ? <img key={k()} src={src} alt={m[2]} loading="lazy" /> : m[2]);
    } else if (m[4]) {
      const href = safeUrl(m[6]!);
      const external = href !== null && /^https?:/i.test(href);
      out.push(
        href ? (
          <a key={k()} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            {inline(m[5]!)}
          </a>
        ) : (
          m[5]
        ),
      );
    } else if (m[7]) out.push(<strong key={k()}>{inline(m[8]!)}</strong>);
    else if (m[9]) out.push(<em key={k()}>{inline(m[10]!)}</em>);
    else if (m[11]) out.push(<code key={k()}>{m[12]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,4}\s|[-*]\s|\d+\.\s|>\s?|```|---\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(4, h[1]!.length + 1); // # in a post body is an h2 (the page owns the h1)
      const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
      out.push(<Tag key={k()}>{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      out.push(<hr key={k()} />);
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!);
      i++;
      out.push(
        <pre key={k()}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(<blockquote key={k()}>{renderMarkdown(q.join('\n'))}</blockquote>);
      continue;
    }
    const ul = /^[-*]\s+/;
    const ol = /^\d+\.\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: ReactNode[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push(<li key={k()}>{inline(lines[i++]!.replace(re, ''))}</li>);
      out.push(ordered ? <ol key={k()}>{items}</ol> : <ul key={k()}>{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!.trim());
    out.push(<p key={k()}>{inline(para.join(' '))}</p>);
  }
  return out;
}
