import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderSite } from './helpers';
import { createHttpNewsletter } from '../../src/site/services/real/newsletter';

async function fill(name: string, email: string) {
  const form = screen.getByTestId('newsletter');
  if (name) await userEvent.type(within(form).getByLabelText('Name'), name);
  if (email) await userEvent.type(within(form).getByLabelText('E-mail'), email);
  await userEvent.click(within(form).getByRole('button', { name: 'Subscribe' }));
}

describe('newsletter form', () => {
  it('validates before sending', async () => {
    const { site } = renderSite('/');
    await fill('Gent', 'not-an-email');
    expect(screen.getByText('Please enter a valid e-mail address.')).toBeInTheDocument();
    expect((site as unknown as { log: string[] }).log.some((l) => l.startsWith('newsletter:'))).toBe(false);
  });

  it('success', async () => {
    renderSite('/');
    await fill('Gent', 'gent@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('Check your inbox to confirm');
  });

  it('already subscribed', async () => {
    renderSite('/');
    await fill('Gent', 'member@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('already on the list');
  });

  it('service error is shown and the form stays usable', async () => {
    renderSite('/');
    await fill('Gent', 'fail@example.com');
    expect(await screen.findByText(/newsletter service is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled();
  });

  it('not configured: disabled with a note, no mailto', () => {
    renderSite('/', { site: { newsletter: { configured: false } } });
    expect(screen.getByText('Newsletter sign-up is not available on this site yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

describe('HTTP newsletter client', () => {
  const client = (status: number, calls: RequestInit[] = []) =>
    createHttpNewsletter({
      url: 'https://n.test/subscribe',
      fetch: async (_u, init) => {
        calls.push(init!);
        return new Response('{}', { status });
      },
    });

  it('POSTs JSON { name, email, channel: email }', async () => {
    const calls: RequestInit[] = [];
    expect(await client(201, calls).subscribe({ name: ' Gent ', email: 'g@x.io ' })).toEqual({ ok: true, alreadySubscribed: false });
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ name: 'Gent', email: 'g@x.io', channel: 'email', source: 'degent.club' });
  });

  it('maps statuses honestly', async () => {
    expect(await client(409).subscribe({ name: 'a', email: 'a@b.co' })).toEqual({ ok: true, alreadySubscribed: true });
    expect(await client(429).subscribe({ name: 'a', email: 'a@b.co' })).toMatchObject({ ok: false, message: /Too many attempts/ });
    expect(await client(500).subscribe({ name: 'a', email: 'a@b.co' })).toMatchObject({ ok: false, message: /HTTP 500/ });
    const none = createHttpNewsletter({ url: '' });
    expect(none.configured).toBe(false);
    expect(await none.subscribe({ name: 'a', email: 'a@b.co' })).toMatchObject({ ok: false });
  });
});
