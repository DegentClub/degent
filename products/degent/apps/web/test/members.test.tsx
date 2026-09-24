/**
 * The member and public pages of ADR-0007: /review (holder sign-in + votes), /explorer (the
 * Register), /verify (the Telegram gate landing), and the declined path on Track.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { voteStatement } from '@bsh/degent-mint-sdk';
import { preparePayment } from '../src/flow/effects';
import { flowReducer } from '../src/flow/reducer';
import { routeFor } from '../src/router';
import { gateStatement, readGateToken } from '../src/screens/Verify';
import { Votes } from '../src/screens/Track';
import { render } from '@testing-library/react';
import type { Order } from '@bsh/degent-mint-sdk';
import { demoOrdinalsAddress } from '../src/services/fakes';
import type { FakeServicesOptions } from '../src/services/fakes';
import { fakes, memoryStore, renderApp, stateAtQuote, testApp } from './helpers';

describe('router', () => {
  it('maps paths to routes', () => {
    expect(routeFor('/')).toBe('mint');
    expect(routeFor('')).toBe('mint');
    expect(routeFor('/review')).toBe('review');
    expect(routeFor('/review/')).toBe('review');
    expect(routeFor('/explorer')).toBe('explorer');
    expect(routeFor('/explorer/4113')).toBe('explorer');
    expect(routeFor('/verify')).toBe('verify');
    expect(routeFor('/anything-else')).toBe('mint');
  });

  it('shows site navigation with the current page marked', async () => {
    renderApp(fakes(), { path: '/explorer' });
    const nav = screen.getByRole('navigation', { name: 'Site' });
    expect(within(nav).getByRole('link', { name: 'Explorer' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/review');
    expect(screen.queryByRole('navigation', { name: 'Mint progress' })).not.toBeInTheDocument();
  });
});

describe('/review', () => {
  it('holder signs in with SIWB (wallet signMessage), sees the queue, approves by signing the statement', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    const services = fakes({ log, mint: { seedReview: 3 } });
    renderApp(services, { path: '/review' });
    expect(await screen.findByRole('heading', { level: 1, name: 'The review.' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in with UniSat' }));
    expect(await screen.findByRole('heading', { name: /Signed in · Degent #17/ })).toBeInTheDocument();
    expect(log.indexOf('api.authChallenge')).toBeLessThan(log.indexOf('wallet.signMessage'));
    expect(log.indexOf('wallet.signMessage')).toBeLessThan(log.indexOf('api.authVerify'));
    const grid = await screen.findByRole('list', { name: 'Orders awaiting member review' });
    const cards = within(grid).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText('1 of 3 approved')).toBeInTheDocument(); // seeded vote by #2049
    expect(within(cards[2]!).getByText('Block Degent')).toBeInTheDocument();
    expect(within(cards[0]!).getByRole('img')).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));
    await user.click(within(cards[0]!).getByRole('button', { name: /^Approve / }));
    expect(await screen.findByText('Vote recorded: 2 of 3 approvals.')).toBeInTheDocument();
    expect(log).toContain('api.castVote:approve');
    // the wallet signed exactly the statement the service expects
    const votes = services.apiVotes.get('ord_demo_review_001')!;
    expect(votes.at(-1)!.message).toBe(voteStatement('approve', 'ord_demo_review_001', [...services.apiOrders.values()].find((o) => o.id === 'ord_demo_review_001')!.contentSha256));
    expect(votes.at(-1)!.degent).toBe(17);
    // one vote per address: the card now shows the member's own vote instead of buttons
    expect(await within(await screen.findByTestId('candidate-ord_demo_review_001')).findByText('You approved')).toBeInTheDocument();
    // decline on another
    await user.click(within(screen.getByTestId('candidate-ord_demo_review_002')).getByRole('button', { name: /^Decline / }));
    expect(await screen.findByText('Vote recorded: 0 of 3 approvals.')).toBeInTheDocument();
    expect(within(screen.getByTestId('candidate-ord_demo_review_002')).getByText('You declined')).toBeInTheDocument();
  });

  it('a wallet that holds no Degent is turned away', async () => {
    const user = userEvent.setup();
    const services = fakes({ mint: { seedReview: 1, holders: {} } });
    renderApp(services, { path: '/review' });
    await user.click(await screen.findByRole('button', { name: 'Sign in with UniSat' }));
    expect(await screen.findByText(/holds no Degent\. Only club members can enter here/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Orders awaiting member review' })).not.toBeInTheDocument();
  });

  it('a declined signature request is reported, not fatal', async () => {
    const user = userEvent.setup();
    const services = fakes({ wallet: { rejectSignMessage: true } });
    renderApp(services, { path: '/review' });
    await user.click(await screen.findByRole('button', { name: 'Sign in with UniSat' }));
    expect(await screen.findByText('User rejected the request.')).toBeInTheDocument();
  });
});

describe('/explorer', () => {
  it('shows the stats header and a paginated, sortable, searchable grid with a detail view', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { path: '/explorer' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Every Degent.' })).toBeInTheDocument();
    const stats = await screen.findByTestId('stats');
    expect(within(stats).getByText('4,112')).toBeInTheDocument();
    expect(within(stats).getByText(/\/ 10,000 \(41\.1%\)/)).toBeInTheDocument();
    expect(within(stats).getByRole('img', { name: /Size histogram/ })).toBeInTheDocument();
    const grid = await screen.findByRole('list', { name: 'Degents' });
    await waitFor(() => expect(within(grid).getAllByRole('listitem')).toHaveLength(24));
    expect(await screen.findByText('4,112 Degents · page 1 of 172')).toBeInTheDocument();
    expect(within(grid).getAllByRole('listitem')[0]).toHaveAttribute('data-testid', 'degent-1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('4,112 Degents · page 2 of 172')).toBeInTheDocument();
    await waitFor(() => expect(within(grid).getAllByRole('listitem')[0]).toHaveAttribute('data-testid', 'degent-25'));
    await user.selectOptions(screen.getByLabelText('Sort'), 'bytes');
    await user.click(screen.getByRole('button', { name: /Order ascending/ }));
    await waitFor(() => expect(within(grid).getAllByRole('listitem')[0]).not.toHaveAttribute('data-testid', 'degent-25'));
    expect(screen.getByText('4,112 Degents · page 1 of 172')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Find'));
    await user.type(screen.getByLabelText('Find'), '#4112');
    expect(await screen.findByText('1 Degents · page 1 of 1')).toBeInTheDocument();
    await user.click(within(grid).getByRole('button', { name: 'Open Degent #4112' }));
    expect(await screen.findByRole('heading', { name: 'Degent #4112' })).toBeInTheDocument();
    expect(screen.getByText('Gallery member (inscribed before the parent)')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Degent #4112 as rendered from the chain' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the grid' }));
    expect(await screen.findByRole('list', { name: 'Degents' })).toBeInTheDocument();
  });
});

describe('/verify (Telegram gate landing)', () => {
  it('reads ?tg=, connects, signs the gate statement and posts it to GATE_URL', async () => {
    const user = userEvent.setup();
    const services = fakes();
    renderApp(services, { path: '/verify', search: '?tg=tok_abc12345' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Prove you hold a Degent.' })).toBeInTheDocument();
    expect(screen.queryByText('No gate token in the link')).not.toBeInTheDocument();
    const sign = screen.getByRole('button', { name: 'Sign & verify' });
    expect(sign).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Connect UniSat' }));
    expect(await screen.findByText(/holds Degent #17/)).toBeInTheDocument();
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);
    expect(await screen.findByText('Welcome, gentleman.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open your invite/ })).toHaveAttribute('href', expect.stringContaining('https://t.me/'));
    const sub = services.gateSubmissions[0]!;
    expect(sub.url).toBe('https://gate.test/verify');
    const body = sub.body as { token: string; address: string; message: string; signature: string };
    expect(body.token).toBe('tok_abc12345');
    expect(body.address).toBe(demoOrdinalsAddress('unisat', 'mainnet'));
    expect(body.message).toContain(`Verify Degent holder ${body.address} for Telegram gate tok_abc12345`);
    expect(body.signature.length).toBeGreaterThan(20);
    expect(services.log).toContain('wallet.signMessage');
  });

  it('warns without a token, and reports a refused gate', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { path: '/verify', search: '' });
    expect(await screen.findByText('No gate token in the link')).toBeInTheDocument();
    expect(readGateToken('?tg=bad token')).toBeNull();
    expect(readGateToken('?tg=ok_token_1')).toBe('ok_token_1');
    expect(gateStatement('t', 'bc1p', '2026-09-23T00:00:00.000Z')).toBe('Verify Degent holder bc1p for Telegram gate t at 2026-09-23T00:00:00.000Z');
    const services = fakes({ gate: { reject: 'token expired' } });
    renderApp(services, { path: '/verify', search: '?tg=tok_expired1' });
    await user.click((await screen.findAllByRole('button', { name: 'Connect UniSat' })).at(-1)!);
    const sign = (await screen.findAllByRole('button', { name: 'Sign & verify' })).at(-1)!;
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);
    expect(await screen.findByText('token expired')).toBeInTheDocument();
  });
});

async function paidAndTracking(opts: FakeServicesOptions = {}) {
  const services = fakes(opts);
  const app = testApp();
  const { state, vault } = await stateAtQuote(services, app);
  const store = memoryStore();
  const p = await preparePayment({ services, vault, app, store }, { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! });
  let s = flowReducer(state, { type: 'ORDER_UPDATED', order: p.order });
  s = flowReducer(s, { type: 'RECOVERY_SAVED', bundle: p.bundle, savedLocally: true });
  s = flowReducer(s, { type: 'FUNDING_BROADCAST', txid: p.funding.txid });
  return { services, app, vault, store, state: s };
}

describe('Track: live votes', () => {
  it('says "2 of 3 members have approved" and lists the signed votes by Degent number', async () => {
    const services = fakes();
    const order = {
      id: 'ord_x',
      status: 'member_review',
      inscriptionId: null,
      contentSha256: 'ab'.repeat(32),
      approval: { approvals: 2, declines: 1, approvalQuorum: 3, declineQuorum: 3, reviewStartedAt: '2026-09-23T12:00:00.000Z', reviewDeadline: '2026-10-07T12:00:00.000Z' },
    } as unknown as Order;
    services.mintApi.getVotes = async () => ({
      orderId: 'ord_x',
      status: 'member_review',
      approval: order.approval!,
      votes: [
        { degent: 17, vote: 'approve', at: '2026-09-23T12:01:00.000Z', signature: 'AA==', message: 'm' },
        { degent: 808, vote: 'decline', at: '2026-09-23T12:02:00.000Z', signature: 'AA==', message: 'm' },
        { degent: 2049, vote: 'approve', at: '2026-09-23T12:03:00.000Z', signature: 'AA==', message: 'm' },
      ],
    });
    render(<Votes order={order} services={services} pollMs={10_000} />);
    expect(await screen.findByText('2 of 3 members have approved')).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 declined/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '2 approvals of 3 needed' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Votes' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Approved by Degent #17'),
      expect.stringContaining('Declined by Degent #808'),
      expect.stringContaining('Approved by Degent #2049'),
    ]);
    expect(screen.getByText(/self-rescue is offered so your funds are never stranded/)).toBeInTheDocument();
  });
});

describe('Track: the members decline', () => {
  it('shows the declined stage and offers the parent-less reveal at once', async () => {
    const t = await paidAndTracking({ mint: { scenario: 'declined' } });
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    expect(await screen.findByRole('heading', { name: 'The members declined — keep your inscription' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByTestId('stage-approve')).toHaveAttribute('data-state', 'problem');
    expect(screen.getByText(/3 of 3 declined/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Reveal without the parent/ }));
    expect(await screen.findByText('Rescue broadcast')).toBeInTheDocument();
    expect(t.services.log).toContain('api.getRescue');
  });
});
