/**
 * Real-browser e2e for the degent.club web app (`pnpm --filter @bsh/degent-web e2e`).
 *
 * Builds nothing itself: run after `vite build` (the script does both via package.json). Serves
 * `vite preview` on a free port, drives the `?demo=1` flow through every screen in headless
 * Chromium at 1280 px and 400 px, fails on any console error / page error / horizontal overflow,
 * and saves full-page screenshots to docs/screenshots/<width>-<nn>-<screen>.png.
 *
 * The walk (site rebuild, p6.1): Home -> #/collection (grid + lightbox) -> #/mint-process ->
 * #/comic -> #/about -> #/manifesto -> #/blog (+ the example post) -> #/gallery -> an artwork ->
 * its #/artists/:address page -> the Artist Studio (sign in, prove payout, set a notification
 * webhook) -> the mint wizard at #/mint through to delivery.
 *
 * Browser: playwright-core (no bundled browsers). Set CHROMIUM_PATH, else /opt/pw-browsers/chromium
 * (a file, or a directory searched for chrome / headless_shell).
 * Google Fonts are stubbed (empty CSS) so the run is hermetic; the UI falls back to system fonts.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });

function findChromium() {
  const start = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  if (!existsSync(start)) throw new Error(`no Chromium at ${start}; set CHROMIUM_PATH`);
  if (statSync(start).isFile()) return start;
  const queue = [start];
  while (queue.length) {
    const d = queue.shift();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isFile() && (e.name === 'chrome' || e.name === 'headless_shell' || e.name === 'chromium')) return p;
      if (e.isDirectory()) queue.push(p);
    }
  }
  throw new Error(`no chrome binary under ${start}`);
}

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });

async function startPreview(port) {
  const vite = join(root, 'node_modules', '.bin', 'vite');
  const child = spawn(vite, ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return { child, url };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`vite preview did not start:\n${out}`);
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function runViewport(browser, url, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.route(/fonts\.googleapis\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(/fonts\.gstatic\.com/, (r) => r.abort());
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const saved = [];
  let n = 0;
  const shot = async (name) => {
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${width}px ${name}: horizontal overflow of ${overflow}px`);
    const navClip = await page.evaluate(() => {
      const nav = document.querySelector('.progress');
      return nav ? nav.scrollWidth - nav.clientWidth : 0;
    });
    check(navClip <= 0, `${width}px ${name}: progress nav clipped by ${navClip}px`);
    const file = join(shots, `${width}-${String(++n).padStart(2, '0')}-${name}.png`);
    // Grow the viewport to the page height instead of `fullPage`: Chromium's beyond-viewport capture
    // paints position:fixed layers (the lacquer backdrop) for the first viewport only.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    await page.screenshot({ path: file });
    await page.setViewportSize({ width, height: 900 });
    saved.push(file);
  };
  const h1 = (re) => page.getByRole('heading', { level: 1, name: re }).waitFor({ timeout: 15_000 });
  const openNav = async () => {
    await page.getByRole('button', { name: 'Menu' }).click();
    return page.getByRole('navigation', { name: 'Site' });
  };

  // `#/` is Home since the site rebuild (p6.1): hero, live meters, the collection card, the comic, the banner.
  await page.goto(`${url}/?demo=1`);
  await page.getByText('DEMO', { exact: true }).waitFor();
  await h1(/Decentralized Gentlemen Club/);
  await page.locator('[data-testid="collection-card"]').waitFor();
  await shot('home');

  // #/collection: hero, collection card, the paged grid and the lightbox (site spec §1-4).
  (await openNav()).getByRole('link', { name: 'The Collection' }).click();
  await h1(/^The Collection$/);
  await page.getByText(/^Showing 1–20 of 4,112$/).waitFor();
  await page.locator('.degent-grid li').first().waitFor();
  await shot('collection');

  await page.getByRole('link', { name: /^DEGENT #1(,|$)/ }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'DEGENT #1' }).waitFor();
  const lightboxImg = page.locator('.lightbox__art img');
  await lightboxImg.waitFor();
  check(await lightboxImg.evaluate((img) => img.complete && img.naturalWidth > 0), 'lightbox image did not decode');
  await page.getByText('Inscription ID').waitFor();
  await shot('collection-lightbox');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  // #/mint-process: the four rule cards and the "Did you know?" callout (site spec §mint process).
  (await openNav()).getByRole('link', { name: 'Mint Process' }).click();
  await h1(/^Minting Rules$/);
  check((await page.locator('.rulecard').count()) === 4, 'expected four minting-rule cards');
  await page.getByRole('heading', { name: 'Did you know?' }).waitFor();
  await shot('mint-process');

  // #/comic (footer Quick Links: no hamburger entry for it).
  await page.getByRole('contentinfo').getByRole('link', { name: 'The Comic' }).click();
  await h1(/This is Gentlemen/);
  await shot('comic');

  // #/about, #/manifesto: TODO(copy) placeholders (site spec: copy not captured, never invented).
  (await openNav()).getByRole('link', { name: 'About' }).click();
  await h1(/^About$/);
  await page.getByText('TODO(copy)').waitFor();
  await shot('about');

  (await openNav()).getByRole('link', { name: 'Manifesto' }).click();
  await h1(/^Manifesto$/);
  await page.getByText('TODO(copy)').waitFor();
  await shot('manifesto');

  // #/blog "Degent Chronicles": the example post from content/blog/*.md.
  (await openNav()).getByRole('link', { name: 'Blog' }).click();
  await h1(/Chronicles/);
  await page.getByText('Example post', { exact: true }).waitFor();
  await shot('blog');
  await page.locator('.postcard__link').first().click();
  await h1(/how a Degent Chronicle is written/);
  await shot('blog-post');

  (await openNav()).getByRole('link', { name: 'Gallery' }).click();
  await h1(/hung by their makers/);
  await page.getByText('Showing 1–3 of 3').waitFor();
  const frames = page.locator('.gallery .frame__img');
  check((await frames.count()) === 3, 'expected three framed artworks');
  for (const img of await frames.all()) check(await img.evaluate((el) => el.complete && el.naturalWidth > 0), 'gallery image did not decode');
  await shot('gallery');

  await page.getByRole('link', { name: /The Chairman by/ }).click();
  await h1(/The Chairman/);
  await page.getByRole('button', { name: 'Mint this Degent' }).waitFor();
  check((await page.locator('.pills .pill').count()) === 5, 'expected five rule pills');
  await shot('artwork');

  // #/artists/:address: joins the studio profile, the certified members and the studio artworks.
  await page.getByRole('link', { name: 'Artist page' }).click();
  await h1(/Ada|bc1/);
  await page.getByTestId('artist-certified').waitFor();
  await shot('artist');

  (await openNav()).getByRole('link', { name: 'Studio' }).click();
  await h1(/Membership is earned by making/);
  await page.getByRole('button', { name: 'Connect UniSat' }).click();
  await page.getByRole('button', { name: 'Sign in with Bitcoin' }).waitFor();
  await page.getByRole('button', { name: 'Sign in with Bitcoin' }).click();
  await page.getByRole('heading', { name: 'Your profile' }).waitFor();
  await page.getByRole('button', { name: 'Prove & save payout address' }).click();
  await page.getByText('✓ Proven').waitFor();
  // ADR-0012: notification settings, with the one-time webhook signing secret.
  await page.getByLabel(/Webhook URL/).fill('https://example.com/degent-hook');
  await page.getByRole('button', { name: 'Save notifications' }).click();
  await page.getByText('Your webhook signing secret: shown once').waitFor();
  await shot('studio');

  // The mint wizard still lives at #/mint (header "Mint" button); no studio artwork was picked, so it
  // opens on the plain wizard welcome screen.
  await page.getByRole('link', { name: 'Mint', exact: true }).click();
  await page.getByText('3 waiting').waitFor();
  for (const t of ['Standard Degent', 'Large Degent', 'Full Block Degent']) await page.getByRole('heading', { level: 2, name: t }).waitFor();
  await shot('welcome');

  await page.getByRole('button', { name: 'Start minting' }).click();
  await h1(/Present your credentials/);
  await page.getByRole('button', { name: 'Connect UniSat' }).click();
  await page.getByText('Connected: UniSat').waitFor();
  await shot('connect');

  await page.getByRole('button', { name: 'Continue to Create' }).click();
  await h1(/Dress the gentleman/);
  await page.getByRole('button', { name: /Use a sample gentleman/ }).click();
  await page.getByText('Fits Standard Degent').waitFor({ timeout: 60_000 });
  const preview = page.getByRole('img', { name: 'Preview rendered from the exact bytes to be inscribed' });
  await preview.waitFor();
  check(await preview.evaluate((img) => img.complete && img.naturalWidth > 0), 'preview image did not decode');
  for (const cb of await page.locator('.brief input[type=checkbox]').all()) await cb.check();
  await shot('create');

  await page.getByRole('button', { name: 'Continue to Validate' }).click();
  await h1(/inspection/);
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.getByText('Approved', { exact: true }).waitFor({ timeout: 15_000 });
  await shot('validate');

  await page.getByRole('button', { name: 'See your quote' }).click();
  await h1(/The bill, itemised/);
  await page.getByText('✓ Verified: matches service').waitFor();
  await shot('quote');

  await page.getByRole('button', { name: 'Continue to Pay' }).click();
  await h1(/Settle the account/);
  await page.getByRole('button', { name: 'Prepare payment' }).click();
  const bundle = JSON.parse(await page.getByLabel('Recovery bundle (JSON)').inputValue());
  check(bundle.version === 2 && /^[0-9a-f]{64}$/.test(bundle.revealPrivkey), 'recovery bundle v2 with K_e expected');
  await page.getByText('Keep it private — it holds a key').waitFor();
  await page.getByRole('checkbox', { name: /I have kept a copy/ }).check();
  await shot('pay');

  await page.getByRole('button', { name: 'Sign & broadcast with UniSat' }).click();
  await h1(/From mempool to membership/);
  await page.locator('[data-testid="step-paid"][data-state="done"]').waitFor({ timeout: 15_000 });
  await shot('track');

  await page.getByText('hash match ✓').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="step-delivered"][data-state="done"]').waitFor({ timeout: 30_000 });
  await page.getByRole('heading', { name: 'Welcome to the club.' }).waitFor();
  const onChain = page.getByRole('img', { name: 'The inscription as rendered from the chain' });
  check(await onChain.evaluate((img) => img.complete && img.naturalWidth > 0), 'on-chain image did not decode');
  await shot('delivered');

  await context.close();
  check(problems.length === 0, `${width}px: browser problems:\n  ${problems.join('\n  ')}`);
  return saved;
}

const port = await freePort();
const { child, url } = await startPreview(port);
let browser;
let failed = false;
try {
  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  for (const width of [1280, 400]) {
    const saved = await runViewport(browser, url, width);
    console.log(`${width}px: ${saved.length} screens OK, no console errors, no horizontal overflow`);
    for (const f of saved) console.log(`  ${f.slice(root.length + 1)}`);
  }
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? e.stack : e);
} finally {
  await browser?.close();
  child.kill();
}
process.exit(failed ? 1 : 0);
