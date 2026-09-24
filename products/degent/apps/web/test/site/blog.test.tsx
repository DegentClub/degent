import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FrontMatterError, parseFrontMatter, toPost } from '../../src/site/lib/frontmatter';
import { renderMarkdown } from '../../src/site/lib/markdown';
import { allPosts, visiblePosts } from '../../src/site/content';
import { renderSite } from './helpers';

describe('front matter parser', () => {
  it('parses strings, quotes, booleans, numbers and lists; CRLF and BOM', () => {
    const src = '﻿---\r\ntitle: "Go: big"\r\ndate: 2026-01-02\r\ndraft: true\r\nn: 3\r\ntags: [a, "b c"]\r\nquote: \'it\'\'s\'\r\n# comment\r\n---\r\nBody\r\n';
    const { data, body } = parseFrontMatter(src);
    expect(data).toEqual({ title: 'Go: big', date: '2026-01-02', draft: true, n: 3, tags: ['a', 'b c'], quote: "it's" });
    expect(body).toBe('Body\n');
  });

  it('no front matter → whole text is the body', () => {
    expect(parseFrontMatter('# hi')).toEqual({ data: {}, body: '# hi' });
  });

  it('rejects malformed blocks', () => {
    expect(() => parseFrontMatter('---\ntitle: x\n')).toThrow(FrontMatterError);
    expect(() => parseFrontMatter('---\nnot a pair\n---\n')).toThrow(/line 1/);
  });

  it('toPost validates required fields and the date', () => {
    expect(() => toPost('x', '---\ndate: 2026-01-01\n---\n')).toThrow(/"title" is required/);
    expect(() => toPost('x', '---\ntitle: T\ndate: Jan 1\n---\n')).toThrow(/YYYY-MM-DD/);
    expect(toPost('file-slug', '---\ntitle: T\ndate: 2026-01-01\n---\nhi')).toMatchObject({ slug: 'file-slug', draft: false, tags: [], body: 'hi' });
    expect(toPost('f', '---\ntitle: T\ndate: 2026-01-01\nslug: kept-wp-slug\n---\n').slug).toBe('kept-wp-slug');
  });
});

describe('blog content', () => {
  it('ships two placeholder drafts, shown only in demo', () => {
    expect(allPosts().map((p) => p.slug).sort()).toEqual(['club-update', 'go-big-or-go-home']);
    expect(allPosts().every((p) => p.draft)).toBe(true);
    expect(visiblePosts(false)).toEqual([]);
    expect(visiblePosts(true)).toHaveLength(2);
  });

  it('demo lists them marked as placeholders; production shows the empty state and 404s the slug', async () => {
    renderSite('/blog');
    expect(screen.getAllByText('Draft · placeholder')).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 2, name: 'Go Big or Go Home' })).toBeInTheDocument();
  });

  it('production hides drafts', () => {
    renderSite('/blog', { app: { demo: false } });
    expect(screen.getByText('No posts yet. Check back soon.')).toBeInTheDocument();
  });

  it('production 404s a draft slug', () => {
    renderSite('/blog/go-big-or-go-home', { app: { demo: false } });
    expect(screen.getByRole('heading', { level: 1, name: /members only/ })).toBeInTheDocument();
  });
});

describe('markdown renderer', () => {
  it('renders the supported subset as elements and never links unsafe URLs', () => {
    render(<div data-testid="md">{renderMarkdown('# Title\n\nSome **bold** and *em* and `code` and [ok](https://x.test) and [bad](javascript:alert(1)).\n\n- one\n- two\n\n> quoted\n\n![alt](https://img.test/a.png)\n\n<script>alert(1)</script>')}</div>);
    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://x.test');
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'alt' })).toHaveAttribute('src', 'https://img.test/a.png');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByTestId('md')).toHaveTextContent('<script>alert(1)</script>');
  });
});
