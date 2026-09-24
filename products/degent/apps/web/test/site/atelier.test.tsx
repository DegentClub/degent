import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { renderSite } from './helpers';
import { fakes } from '../helpers';
import { createFakeAtelier, createFakeSiteServices } from '../../src/site/services/fakes';
import { AtelierError } from '../../src/site/services/types';
import { rulesOk, rulesStatus } from '../../src/site/lib/atelierRules';
import { syntheticJpeg } from '../../src/site/lib/jpeg';
import { ITEMS } from './helpers';

/** Mint services whose uploadContent records the exact bytes the mint receives. */
function capturingMint() {
  const mint = fakes();
  const uploads: Uint8Array[] = [];
  const orig = mint.mintApi.uploadContent.bind(mint.mintApi);
  mint.mintApi.uploadContent = async (id, token, bytes) => {
    uploads.push(bytes);
    return orig(id, token, bytes);
  };
  return { mint, uploads };
}

async function connectAndValidate() {
  // No wallet yet: the handoff lands on Connect, whose continue button goes straight to Validate.
  expect(await screen.findByRole('heading', { level: 1, name: /Present your credentials/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Connect UniSat' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Continue to Validate' }));
  expect(await screen.findByRole('heading', { level: 1, name: /inspection/ })).toBeInTheDocument();
}

describe('Atelier: generate → poll → select → finalize → mint', () => {
  it('runs the job lifecycle and hands the EXACT bytes to /mint (skipping Create)', async () => {
    const atelier = createFakeAtelier({ pollsUntilDone: 3 });
    const site = createFakeSiteServices({ items: ITEMS });
    site.atelier = atelier;
    const { mint, uploads } = capturingMint();
    const { path } = renderSite('/atelier', { siteServices: site, mintServices: mint });

    expect(await screen.findByText('Image provider not configured')).toBeInTheDocument();
    expect(await screen.findByTestId('quota')).toHaveTextContent('0 of 12 images used today');
    // the rules checklist is always visible
    expect(screen.getAllByTestId('rules-checklist')[0]).toHaveTextContent('Square JPEG, at least 200 KB');

    const generate = screen.getByRole('button', { name: /Generate/ });
    expect(generate).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your brief'), 'DJ at a rooftop party');
    await userEvent.click(screen.getByRole('button', { name: 'noir' }));
    await userEvent.click(screen.getByRole('radio', { name: 'REGEN' }));
    await userEvent.click(screen.getByRole('radio', { name: '3' }));
    await userEvent.click(generate);

    const cands = await screen.findByTestId('candidates');
    expect(within(cands).getAllByRole('img')).toHaveLength(3);
    expect(atelier.log.filter((l) => l.startsWith('atelier.job:'))).toEqual(['atelier.job:queued', 'atelier.job:running', 'atelier.job:done']);
    expect(atelier.log).toContain('atelier.generate:3');
    expect(screen.getByTestId('quota')).toHaveTextContent('3 of 12 images used today');
    // per-candidate checklist: design by construction, frame by construction, format pending
    const c1 = screen.getByTestId('cand-rules-1');
    expect(c1.querySelector('[data-rule="design"]')).toHaveAttribute('data-state', 'construction');
    expect(c1.querySelector('[data-rule="format"]')).toHaveAttribute('data-state', 'pending');

    await userEvent.click(within(cands).getAllByRole('radio')[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Finalize selected' }));
    const final = await screen.findByTestId('final');
    const [sha, bytes] = [...atelier.contents.entries()][0]!;
    expect(atelier.log).toContain('atelier.finalize:cand_job_000001_2');
    expect(within(final).getByTestId('final-sha')).toHaveTextContent(sha);
    expect(within(final).getByTestId('final-bytes')).toHaveTextContent(bytes.length.toLocaleString('en-US'));
    expect(within(final).getByText('1024×1024 px')).toBeInTheDocument();
    expect(within(screen.getByTestId('final-rules')).getByText(/“REGEN” placard drawn/)).toBeInTheDocument();
    expect(screen.getByTestId('final-rules').querySelector('[data-rule="format"]')).toHaveAttribute('data-state', 'pass');

    await userEvent.click(within(final).getByRole('button', { name: /Mint this/ }));
    expect(path()).toBe('/mint');
    await connectAndValidate();
    expect(screen.getByTestId('handoff-facts')).toHaveTextContent(sha);
    expect(screen.getByText('Art from the Atelier')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    // bytes identical, sha256 identical
    expect(uploads[0]).toEqual(bytes);
    expect(uploads[0]!.length).toBe(bytes.length);
    expect(sha256Hex(uploads[0]!)).toBe(sha);
    expect(await screen.findByText('Approved', { exact: true })).toBeInTheDocument();
  });

  it('refuses bytes whose hash does not match the finalised hash', async () => {
    const atelier = createFakeAtelier();
    const orig = atelier.getContent.bind(atelier);
    atelier.getContent = async (sha) => {
      const b = await orig(sha);
      b[b.length - 5]! ^= 0xff;
      return b;
    };
    const site = createFakeSiteServices({ items: ITEMS });
    site.atelier = atelier;
    renderSite('/atelier', { siteServices: site });
    await userEvent.type(screen.getByLabelText('Your brief'), 'pharaoh');
    await userEvent.click(screen.getByRole('button', { name: /Generate/ }));
    await screen.findByTestId('candidates');
    await userEvent.click(screen.getByRole('button', { name: 'Finalize selected' }));
    expect(await screen.findByText(/does not match the finalised hash/)).toBeInTheDocument();
    expect(screen.queryByTestId('final')).toBeNull();
  });

  it.each([
    [new AtelierError('quota_exceeded', 'Daily image quota reached (12 of 12 used).', 429), /quota reached.*resets at 00:00 UTC/],
    [new AtelierError('rate_limited', 'slow down', 429, 17), /Try again in 17 seconds/],
    [new AtelierError('cost_cap_reached', 'cap', 503), /today’s image budget/],
  ])('renders %s honestly', async (err, text) => {
    renderSite('/atelier', { site: { atelier: { generateError: err } } });
    await userEvent.type(screen.getByLabelText('Your brief'), 'royalty');
    await userEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText('Generation failed')).toBeInTheDocument();
  });

  it('a failed job shows the provider message', async () => {
    renderSite('/atelier', { site: { atelier: { failJobs: true } } });
    await userEvent.type(screen.getByLabelText('Your brief'), 'space');
    await userEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText(/image provider is unavailable/)).toBeInTheDocument();
  });

  it('quota runs out after 12 images', async () => {
    renderSite('/atelier', { site: { atelier: { usedToday: 11 } } });
    await userEvent.type(screen.getByLabelText('Your brief'), 'casino');
    await userEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText(/Daily image quota reached \(11 of 12 used\)/)).toBeInTheDocument();
  });

  it('says so when the Atelier is not configured, and upload-as-is still works', async () => {
    renderSite('/atelier', { site: { atelier: { configured: false } } });
    expect(screen.getByText('The Atelier is not configured on this site')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Bring your own art' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Frame it for me' }));
    expect(screen.getByText('Framing needs the Atelier')).toBeInTheDocument();
  });
});

describe('Atelier: bring your own art', () => {
  const file = (bytes: Uint8Array, name = 'my-gent.jpg') => new File([bytes.slice()], name, { type: 'image/jpeg' });

  it('use as-is: the file bytes go to the mint unchanged', async () => {
    const bytes = syntheticJpeg(1200, 1200, 256_789, 5);
    const { mint, uploads } = capturingMint();
    renderSite('/atelier', { mintServices: mint });
    await userEvent.click(screen.getByRole('tab', { name: 'Bring your own art' }));
    await userEvent.upload(screen.getByLabelText('Choose an image file'), file(bytes));
    const final = await screen.findByTestId('final');
    expect(within(final).getByTestId('final-sha')).toHaveTextContent(sha256Hex(bytes));
    const mintBtn = within(final).getByRole('button', { name: /Mint this/ });
    expect(mintBtn).toBeDisabled(); // design + frame not confirmed yet
    await userEvent.click(screen.getByRole('checkbox', { name: /Pepe in a tuxedo/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /framed, with a DEGEN/ }));
    expect(mintBtn).toBeEnabled();
    await userEvent.click(mintBtn);
    await connectAndValidate();
    expect(screen.getByText('Your own art')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toEqual(bytes);
  });

  it('use as-is: a non-square or undersized file fails the format rule and cannot be minted', async () => {
    renderSite('/atelier');
    await userEvent.click(screen.getByRole('tab', { name: 'Bring your own art' }));
    await userEvent.upload(screen.getByLabelText('Choose an image file'), file(syntheticJpeg(1200, 900, 150_000)));
    const final = await screen.findByTestId('final');
    const fmt = screen.getByTestId('final-rules').querySelector('[data-rule="format"]')!;
    expect(fmt).toHaveAttribute('data-state', 'fail');
    expect(fmt).toHaveTextContent('1200×900 is not square');
    expect(fmt).toHaveTextContent('under 200 KB');
    await userEvent.click(screen.getByRole('checkbox', { name: /Pepe in a tuxedo/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /framed, with a DEGEN/ }));
    expect(within(final).getByRole('button', { name: /Mint this/ })).toBeDisabled();
  });

  it('frame it for me: the Atelier composes, and its exact bytes are handed over', async () => {
    const atelier = createFakeAtelier();
    const site = createFakeSiteServices({ items: ITEMS });
    site.atelier = atelier;
    const { mint, uploads } = capturingMint();
    renderSite('/atelier', { siteServices: site, mintServices: mint });
    await userEvent.click(screen.getByRole('tab', { name: 'Bring your own art' }));
    await userEvent.upload(screen.getByLabelText('Choose an image file'), file(syntheticJpeg(800, 600, 90_000)));
    await userEvent.click(screen.getByRole('radio', { name: 'Frame it for me' }));
    await userEvent.click(screen.getByRole('radio', { name: 'DEGENT' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Pepe in a tuxedo/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Frame it' }));
    const final = await screen.findByTestId('final');
    expect(atelier.log).toContain('atelier.upload:frame');
    const [sha, bytes] = [...atelier.contents.entries()][0]!;
    expect(within(final).getByTestId('final-sha')).toHaveTextContent(sha);
    await userEvent.click(within(final).getByRole('button', { name: /Mint this/ }));
    await connectAndValidate();
    await userEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toEqual(bytes);
  });

  it('drag and drop picks the file', async () => {
    renderSite('/atelier');
    await userEvent.click(screen.getByRole('tab', { name: 'Bring your own art' }));
    const f = file(syntheticJpeg(1024, 1024, 210_000), 'dropped.jpg');
    const zone = screen.getByTestId('dropzone');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.drop(zone, { dataTransfer: { files: [f] } });
    expect(await screen.findByTestId('picked')).toHaveTextContent('dropped.jpg');
  });
});

describe('rulesStatus', () => {
  it('upload as-is needs attestations; generated art holds design by construction', () => {
    const final = { contentType: 'image/jpeg', width: 1024, height: 1024, size: 300_000 };
    expect(rulesOk(rulesStatus({ path: 'upload-asis', final }))).toBe(false);
    expect(rulesOk(rulesStatus({ path: 'upload-asis', final, attest: { design: true, frame: true } }))).toBe(true);
    expect(rulesOk(rulesStatus({ path: 'generate', candidate: true, final, placard: 'DEGEN' }))).toBe(true);
    expect(rulesOk(rulesStatus({ path: 'generate', candidate: true, placard: 'DEGEN' }))).toBe(false);
    const rejected = rulesStatus({ path: 'generate', candidate: true, final, placard: 'DEGEN', review: { approved: false, reasons: ['no bowtie'], checks: [{ id: 'bowtie', passed: false, detail: 'missing' }] } });
    expect(rejected.find((r) => r.id === 'design')!.state).toBe('fail');
  });
});
