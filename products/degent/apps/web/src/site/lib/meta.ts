/**
 * Per-page <title>, description and OpenGraph tags, set client-side on navigation. Browsers and
 * share previews that run JavaScript pick these up; crawlers that do not (most OpenGraph scrapers)
 * need a prerender / edge rewrite of index.html — see README "Deep links and OpenGraph".
 */
import { useEffect } from 'react';

export interface DocMeta {
  title: string;
  description?: string;
  image?: string;
  url?: string;
}

export const SITE_NAME = 'degent.club';

function setMeta(attr: 'name' | 'property', key: string, content: string | undefined) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!content) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

export function applyMeta(m: DocMeta): void {
  const title = m.title ? `${m.title} · ${SITE_NAME}` : SITE_NAME;
  document.title = title;
  setMeta('name', 'description', m.description);
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', m.description);
  setMeta('property', 'og:image', m.image);
  setMeta('property', 'og:url', m.url);
  setMeta('property', 'og:type', 'website');
  setMeta('name', 'twitter:card', m.image ? 'summary_large_image' : 'summary');
}

export function useDocumentMeta(m: DocMeta): void {
  useEffect(() => {
    applyMeta(m);
  }, [m.title, m.description, m.image, m.url]); // eslint-disable-line react-hooks/exhaustive-deps
}
