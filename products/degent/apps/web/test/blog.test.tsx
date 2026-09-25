import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { collectPosts, parsePost, POSTS } from '../src/lib/blog';
import { parseFrontMatter, renderMarkdown } from '../src/lib/markdown';
import { fakes, renderApp } from './helpers';

describe('blog content source (content/blog/*.md, bundled with import.meta.glob ?raw)', () => {
  it('bundles the example post, clearly marked as an example', () => {
    expect(POSTS.length).toBeGreaterThanOrEqual(1);
    const ex = POSTS.find((p) => p.slug === 'example-how-to-write-a-chronicle')!;
    expect(ex).toBeDefined();
    expect(ex.example).toBe(true);
    expect(ex.title).toMatch(/^Example post/);
    expect(ex.body).toContain('This is an example post');
  });

  it('front matter: slug defaults to the file name (keep WordPress slugs), invalid posts are skipped, newest first', () => {
    const a = parsePost('/content/blog/go-big-or-go-home.md', '---\ntitle: "Go big"\ndate: 2025-01-02\n---\nBody');
    expect(a).toMatchObject({ slug: 'go-big-or-go-home', title: 'Go big', date: '2025-01-02', example: false, body: 'Body' });
    expect(parsePost('/x/y.md', '---\ntitle: T\ndate: 2025-01-02\nslug: wp-slug-2021\n---\n')?.slug).toBe('wp-slug-2021');
    expect(parsePost('/x/nodate.md', '---\ntitle: T\n---\n')).toBeNull();
    expect(parsePost('/x/y.md', 'no front matter')).toBeNull();
    const posts = collectPosts({
      '/a.md': '---\ntitle: Old\ndate: 2024-01-01\n---\n',
      '/b.md': '---\ntitle: New\ndate: 2026-01-01\n---\n',
    });
    expect(posts.map((p) => p.title)).toEqual(['New', 'Old']);
    expect(parseFrontMatter("---\nk: 'v'\n---\nrest")).toEqual({ meta: { k: 'v' }, body: 'rest' });
  });

  it('renders Markdown safely: headings shifted below the page h1, lists, code, quotes; raw HTML stays text, javascript: links are dropped', () => {
    render(
      <div data-testid="md">
        {renderMarkdown(
          '# Title\n\nSome **bold**, *em*, `code` and [a link](https://degent.club).\n\n- one\n- two\n\n1. first\n\n> quoted\n\n```\nx  y\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))',
        )}
      </div>,
    );
    const md = screen.getByTestId('md');
    expect(within(md).getByRole('heading', { level: 2, name: 'Title' })).toBeInTheDocument();
    expect(md.querySelector('strong')).toHaveTextContent('bold');
    expect(md.querySelector('em')).toHaveTextContent('em');
    expect(within(md).getByRole('link', { name: 'a link' })).toHaveAttribute('href', 'https://degent.club');
    expect(within(md).getAllByRole('listitem')).toHaveLength(3);
    expect(md.querySelector('blockquote')).toHaveTextContent('quoted');
    expect(md.querySelector('pre code')?.textContent).toBe('x  y');
    expect(md.querySelector('script')).toBeNull();
    expect(md).toHaveTextContent('<script>alert(1)</script>');
    expect(within(md).queryByRole('link', { name: 'bad' })).toBeNull();
  });
});

describe('Blog pages (#/blog, #/blog/:slug)', () => {
  it('“Degent Chronicles” lists the example post with its badge and links to it by slug', async () => {
    renderApp(fakes(), { hash: '#/blog' });
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Degent Chronicles');
    expect(h1.querySelector('.accent')).toHaveTextContent('Chronicles');
    const posts = screen.getByRole('list', { name: 'Posts' });
    const card = within(posts).getAllByRole('listitem')[0]!;
    expect(card).toHaveTextContent('Example post');
    expect(within(card).getByRole('link')).toHaveAttribute('href', '#/blog/example-how-to-write-a-chronicle');
  });

  it('renders a post from Markdown, and says so for an unknown slug', async () => {
    renderApp(fakes(), { hash: '#/blog/example-how-to-write-a-chronicle' });
    expect(await screen.findByRole('heading', { level: 1, name: /Example post/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Where posts live' })).toBeInTheDocument();
    expect(screen.getByText('Example post', { selector: '.badge' })).toBeInTheDocument();
    window.location.hash = '#/blog/no-such-post';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 1, name: 'No such chronicle.' })).toBeInTheDocument();
  });
});
