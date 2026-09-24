import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ITEMS, renderSite } from './helpers';
import { fakeInscriptionDetails } from '../../src/site/services/fakes';

describe('collection gallery', () => {
  it('paginates with the full toolbar', async () => {
    const { container } = renderSite('/collection');
    const gallery = await screen.findByTestId('gallery');
    expect(within(gallery).getAllByRole('link')).toHaveLength(20);
    expect(screen.getByTestId('showing')).toHaveTextContent('Showing 1–20 of 45');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('showing')).toHaveTextContent('Showing 21–40 of 45');
    await userEvent.click(screen.getByRole('button', { name: 'Last page' }));
    expect(within(screen.getByTestId('gallery')).getAllByRole('link')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');
    await userEvent.type(screen.getByLabelText('Go to'), '1{Enter}');
    expect(screen.getByTestId('showing')).toHaveTextContent('Showing 1–20 of 45');
    await userEvent.selectOptions(screen.getByLabelText('Per page'), '40');
    expect(screen.getByTestId('showing')).toHaveTextContent('Showing 1–40 of 45');
    expect(within(screen.getByTestId('gallery')).getAllByText(/^DEGENT #/)[1]).toHaveTextContent('DEGENT #2');
    expect(container.querySelector('.pager')).toBeInTheDocument();
  });
});

describe('lightbox', () => {
  it('opens from the grid, shows LOADING then the on-chain facts, and prefetches neighbours', async () => {
    const { path, site } = renderSite('/collection', { site: { ord: { delayMs: 20 } } });
    const gallery = await screen.findByTestId('gallery');
    await userEvent.click(within(gallery).getByRole('link', { name: /Degent #5,/ }));
    expect(path()).toBe('/collection/5');
    const box = screen.getByTestId('lightbox');
    expect(within(box).getByRole('heading', { name: 'DEGENT #5' })).toBeInTheDocument();
    expect(within(box).getByTestId('lb-facts')).toHaveAttribute('data-status', 'loading');
    expect(within(box).getByTestId('lb-height')).toHaveTextContent('Loading…');
    const d = fakeInscriptionDetails(ITEMS[4]!.id);
    await waitFor(() => expect(within(box).getByTestId('lb-address')).toHaveTextContent(d.address!));
    expect(within(box).getByTestId('lb-contentType')).toHaveTextContent('image/jpeg');
    expect(within(box).getByTestId('lb-height')).toHaveTextContent(d.height!.toLocaleString('en-US'));
    expect(within(box).getByTestId('lb-fee')).toHaveTextContent(`${d.fee!.toLocaleString('en-US')} sats`);
    expect(within(box).getByText(ITEMS[4]!.id)).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: /View on Ordinals.com/ })).toHaveAttribute('href', `https://ordinals.com/inscription/${ITEMS[4]!.id}`);
    expect(within(box).getByRole('link', { name: /Buy Item/ })).toHaveAttribute('href', `https://magiceden.io/ordinals/item-details/${ITEMS[4]!.id}`);
    const calls = (site as unknown as { log: string[] }).log;
    for (const n of [4, 6, 3, 7]) expect(calls).toContain(`ord.inscription:${ITEMS[n - 1]!.id}`);
    expect(document.title).toBe('Degent #5 · degent.club');
  });

  it('prev / next / filmstrip / keyboard navigate; prefetched neighbours show without loading', async () => {
    const { path } = renderSite('/collection/5', { site: { ord: { delayMs: 5 } } });
    const box = await screen.findByTestId('lightbox');
    await waitFor(() => expect(within(box).getByTestId('lb-facts')).toHaveAttribute('data-status', 'ok'));
    await new Promise((r) => setTimeout(r, 20)); // let the neighbour prefetch finish
    await userEvent.click(within(box).getByRole('button', { name: 'Next Degent' }));
    expect(path()).toBe('/collection/6');
    await waitFor(() => expect(within(screen.getByTestId('lightbox')).getByTestId('lb-facts')).toHaveAttribute('data-status', 'ok'));
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(path()).toBe('/collection/4');
    await userEvent.click(within(screen.getByTestId('lightbox')).getByRole('button', { name: 'Degent #8' }));
    expect(path()).toBe('/collection/8');
    await userEvent.keyboard('{Escape}');
    expect(path()).toBe('/collection');
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('first item has no previous; the deep link puts the grid on the right page', async () => {
    renderSite('/collection/41');
    const box = await screen.findByTestId('lightbox');
    expect(within(box).getByRole('button', { name: 'Next Degent' })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('showing')).toHaveTextContent('Showing 41–45 of 45'));
    await userEvent.keyboard('{Escape}');
    renderSite('/collection/1');
    expect(within((await screen.findAllByTestId('lightbox')).at(-1)!).getByRole('button', { name: 'Previous Degent' })).toBeDisabled();
  });

  it('shows an error with retry when ord fails', async () => {
    renderSite('/collection/3', { site: { ord: { failing: new Set([ITEMS[2]!.id]) } } });
    const box = await screen.findByTestId('lightbox');
    expect(await within(box).findByRole('alert')).toHaveTextContent('Could not load the on-chain details');
    expect(within(box).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('an unknown number says so instead of inventing data', async () => {
    renderSite('/collection/9999');
    const box = await screen.findByTestId('lightbox');
    expect(within(box).getByRole('heading', { name: 'DEGENT #9999' })).toBeInTheDocument();
    expect(within(box).getByText(/not in the collection list yet/)).toBeInTheDocument();
  });
});
