import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script without types
import { htmlToMarkdown, postToMarkdown } from '../../scripts/import-wordpress.mjs';
import { toPost } from '../../src/site/lib/frontmatter';

describe('WordPress import', () => {
  it('converts a wp/v2 post into a front-matter markdown file the site parses', () => {
    const { slug, file } = postToMarkdown({
      id: 1,
      slug: 'go-big-or-go-home',
      status: 'publish',
      date: '2025-03-04T10:00:00',
      title: { rendered: 'GO BIG OR GO HOME!' },
      excerpt: { rendered: '<p>Large &amp; Full Block Degents [&hellip;]</p>' },
      content: {
        rendered:
          '<h2>Big</h2><p>Mint a <strong>Large</strong> Degent at <a href="https://degent.club/mint/">the mint</a>.</p><ul><li>one</li><li>two</li></ul><script>x()</script><img src="https://degent.club/wp-content/a.jpg" alt="A">[gallery ids="1"]<a href="javascript:bad()">bad</a>',
      },
      _embedded: { 'wp:featuredmedia': [{ source_url: 'https://degent.club/wp-content/cover.jpg' }] },
    });
    expect(slug).toBe('go-big-or-go-home');
    const post = toPost('ignored', file);
    expect(post).toMatchObject({ slug: 'go-big-or-go-home', title: 'GO BIG OR GO HOME!', date: '2025-03-04', draft: false, cover: 'https://degent.club/wp-content/cover.jpg', excerpt: 'Large & Full Block Degents' });
    expect(post.body).toContain('# Big');
    expect(post.body).toContain('Mint a **Large** Degent at [the mint](https://degent.club/mint/).');
    expect(post.body).toContain('- one\n- two');
    expect(post.body).toContain('![A](https://degent.club/wp-content/a.jpg)');
    expect(post.body).not.toContain('x()');
    expect(post.body).not.toContain('gallery');
    expect(post.body).not.toContain('javascript:');
  });

  it('refuses posts without a usable slug', () => {
    expect(() => postToMarkdown({ slug: '', title: { rendered: 'x' }, date: '2025-01-01' })).toThrow(/slug/);
  });

  it('decodes entities and collapses blank lines', () => {
    expect(htmlToMarkdown('<p>a &ndash; b</p><p></p><p>c&#8217;s</p>')).toBe('a – b\n\nc’s\n');
  });
});
