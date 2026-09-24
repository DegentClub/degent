import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, RouterProvider, carrySearch, hrefFor, memoryHistory, parseRoute, routePath, useRouter, type Route } from '../../src/site/router';
import { renderSite } from './helpers';

describe('parseRoute / routePath', () => {
  const cases: Array<[string, Route]> = [
    ['/', { name: 'home' }],
    ['/collection', { name: 'collection', n: null }],
    ['/collection/', { name: 'collection', n: null }],
    ['/collection/42', { name: 'collection', n: 42 }],
    ['/mint', { name: 'mint' }],
    ['/mint/', { name: 'mint' }],
    ['/atelier', { name: 'atelier' }],
    ['/comic', { name: 'comic' }],
    ['/manifesto', { name: 'manifesto' }],
    ['/about', { name: 'about' }],
    ['/how-it-works', { name: 'how' }],
    ['/mint-process', { name: 'how' }],
    ['/blog', { name: 'blog' }],
    ['/blog/go-big-or-go-home/', { name: 'post', slug: 'go-big-or-go-home' }],
    ['/club', { name: 'club' }],
  ];
  it.each(cases)('%s', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it('rejects junk as notfound', () => {
    for (const p of ['/collection/0', '/collection/abc', '/collection/1/2', '/nope', '/blog/Bad_Slug', '/mint/x']) {
      expect(parseRoute(p).name).toBe('notfound');
    }
  });

  it('round-trips every named route', () => {
    for (const [, r] of cases) expect(parseRoute(routePath(r))).toEqual(r);
  });
});

describe('search carrying', () => {
  it('keeps only demo', () => {
    expect(carrySearch('?demo=1&utm=x')).toBe('?demo=1');
    expect(carrySearch('?utm=x')).toBe('');
    expect(hrefFor('/collection', '?demo=1')).toBe('/collection?demo=1');
    expect(hrefFor('/collection?page=2', '?demo=1')).toBe('/collection?demo=1&page=2');
  });
});

function Where() {
  const { route } = useRouter();
  return <p data-testid="where">{route.name}</p>;
}

describe('RouterProvider + Link', () => {
  it('navigates with pushState-like history and keeps ?demo=1', async () => {
    const history = memoryHistory('/?demo=1');
    render(
      <RouterProvider history={history}>
        <Link to="/blog">Blog</Link>
        <Where />
      </RouterProvider>,
    );
    expect(screen.getByTestId('where')).toHaveTextContent('home');
    expect(screen.getByRole('link', { name: 'Blog' })).toHaveAttribute('href', '/blog?demo=1');
    await userEvent.click(screen.getByRole('link', { name: 'Blog' }));
    expect(screen.getByTestId('where')).toHaveTextContent('blog');
    expect(history.entries.at(-1)).toBe('/blog?demo=1');
  });

  it('follows back/forward style replacements', () => {
    const history = memoryHistory('/');
    render(
      <RouterProvider history={history}>
        <Where />
      </RouterProvider>,
    );
    act(() => history.replace('/club'));
    expect(screen.getByTestId('where')).toHaveTextContent('club');
  });

  it('the site navigates through the slide-out menu', async () => {
    const { path } = renderSite('/');
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Site menu' });
    for (const n of ['Home', 'About', 'The Collection', 'Mint Process', 'Manifesto', 'Blog']) {
      expect(dialog).toContainElement(screen.getAllByRole('link', { name: n }).find((a) => dialog.contains(a))!);
    }
    await userEvent.click(screen.getAllByRole('link', { name: 'Mint Process' }).find((a) => dialog.contains(a))!);
    expect(path()).toBe('/how-it-works');
    expect(screen.queryByRole('dialog', { name: 'Site menu' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Minting Rules' })).toBeInTheDocument();
  });

  it('the menu closes on Escape and returns focus to the burger', async () => {
    renderSite('/');
    const burger = screen.getByRole('button', { name: 'Open menu' });
    await userEvent.click(burger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Site menu' })).toBeNull();
    expect(burger).toHaveFocus();
  });
});
