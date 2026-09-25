/**
 * Real-browser e2e for degent.club (`pnpm --filter @bsh/degent-web e2e`).
 *
 * Builds nothing itself: run after `vite build` (the script does both via package.json). Serves
 * `vite preview` on a free port and, in headless Chromium at 1280 px and 400 px with `?demo=1`:
 *  1. renders every site page (home, collection, lightbox deep link, atelier, comic, manifesto,
 *     about, how-it-works, blog, blog post, club, 404) plus the open menu, and drives the Atelier
 *     (generate → finalize → "Mint this" → Validate with the same SHA-256), the lightbox (next,
 *     Escape) and the Club sign-in; screenshots: docs/screenshots/site-<width>-<name>.png;
 *  2. drives the mint at /mint through all eight screens; screenshots:
 *     docs/screenshots/<width>-<nn>-<screen>.png.
 * Fails on any console error, page error or horizontal page overflow.
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

  await page.goto(`${url}/mint?demo=1`);
  await page.getByText('DEMO', { exact: true }).waitFor();
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


async function newPage(browser, url, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.route(/fonts\.googleapis\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(/fonts\.gstatic\.com/, (r) => r.abort());
  // Demo mode must not touch the network: fail on any request that is not the preview server.
  const external = [];
  await context.route(/^https?:\/\//, (r) => {
    const u = r.request().url();
    if (u.startsWith(url) || /fonts\.(googleapis|gstatic)\.com/.test(u)) return r.fallback();
    external.push(u);
    return r.abort();
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return { context, page, problems, external };
}

async function fullShot(page, width, file) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${width}px ${file}: horizontal overflow of ${overflow}px`);
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, window.innerHeight));
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(shots, file) });
  await page.setViewportSize({ width, height: 900 });
}

/** Viewport-only shot (dialogs and fixed layers: the menu, the lightbox). */
async function viewShot(page, width, file) {
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${width}px ${file}: horizontal overflow of ${overflow}px`);
  await page.screenshot({ path: join(shots, file) });
}

const SITE_PAGES = [
  ['home', '/', /The Decentralized/],
  ['collection', '/collection', /The Collection/],
  ['exhibit', '/exhibit', /The Full Block/],
  ['exhibit-item', '/exhibit/2770', /Degent #2770/],
  ['atelier', '/atelier', /Dress your gentleman/],
  ['comic', '/comic', /This is Gentlemen- The Comic/],
  ['manifesto', '/manifesto', /Manifesto/],
  ['about', '/about', /About/],
  ['how-it-works', '/how-it-works', /Minting Rules/],
  ['blog', '/blog', /Degent Chronicles/],
  ['blog-post', '/blog/go-big-or-go-home', /Go Big or Go Home/],
  ['club', '/club', /The Club/],
  ['404', '/no-such-room', /members only/],
];

async function runSite(browser, url, width) {
  const { context, page, problems, external } = await newPage(browser, url, width);
  const saved = [];
  const h1 = (re) => page.getByRole('heading', { level: 1, name: re }).first().waitFor({ timeout: 15_000 });
  const shot = async (name, view = false) => {
    const file = `site-${width}-${name}.png`;
    await (view ? viewShot : fullShot)(page, width, file);
    saved.push(join(shots, file));
  };

  for (const [name, path, re] of SITE_PAGES) {
    await page.goto(`${url}${path}?demo=1`);
    await h1(re);
    await page.getByTestId(width >= 1100 ? 'meter-minted' : 'strip-meter-minted').waitFor();
    if (name === 'home' || name === 'collection') await page.locator('.frame__caption').first().waitFor();
    // lazy images: scroll through once so every visible frame has decoded before the shot
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 30));
      }
      window.scrollTo(0, 0);
    });
    await shot(name);
  }
  const minted = await page.getByTestId(width >= 1100 ? 'meter-minted' : 'strip-meter-minted').textContent();
  check(/^4,112 \/ 10K$/.test(minted.trim()), `meter shows "${minted}" (bundled manifest expected in demo)`);
  check(!(await page.content()).includes('4,027'), 'the hardcoded live-site count 4,027 must never render');

  // Menu
  await page.goto(`${url}/?demo=1`);
  await h1(/The Decentralized/);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('dialog', { name: 'Site menu' }).waitFor();
  await shot('menu', true);
  await page.keyboard.press('Escape');

  // Lightbox via deep link, then next + Escape
  await page.goto(`${url}/collection/5?demo=1`);
  const box = page.getByTestId('lightbox');
  await box.waitFor();
  await page.locator('[data-testid="lb-facts"][data-status="ok"]').waitFor({ timeout: 10_000 });
  const fit = await page.evaluate(() => {
    const p = document.querySelector('.lightbox__panel');
    const r = p.getBoundingClientRect();
    return { right: r.right, left: r.left, vw: document.documentElement.clientWidth, inner: p.scrollWidth - p.clientWidth };
  });
  check(fit.left >= 0 && fit.right <= fit.vw + 0.5 && fit.inner <= 0, `${width}px lightbox does not fit the viewport: ${JSON.stringify(fit)}`);
  check((await page.title()).startsWith('Degent #5'), `per-item title, got "${await page.title()}"`);
  await shot('lightbox', true);
  await box.getByRole('button', { name: 'Next Degent' }).click();
  await box.getByRole('heading', { name: 'DEGENT #6' }).waitFor();
  check(new URL(page.url()).pathname === '/collection/6', 'next updates the deep link');
  await page.keyboard.press('Escape');
  check(new URL(page.url()).pathname === '/collection', 'Escape closes the lightbox');

  // Full Block Exhibit: the one-block visualization must be drawn to scale (fill width === weight/4,000,000)
  await page.goto(`${url}/exhibit/2770?demo=1`);
  await h1(/Degent #2770/);
  await page.getByTestId('one-block-viz').first().waitFor();
  const scale = await page.evaluate(() => {
    const viz = document.querySelector('[data-testid="one-block-viz"]');
    const fill = viz.querySelector('[data-testid="oneblock-fill"]');
    const weight = Number(viz.getAttribute('data-weight'));
    const block = Number(viz.getAttribute('data-block-weight'));
    const fraction = Number(viz.getAttribute('data-fraction'));
    const widthPct = parseFloat(getComputedStyle(fill).width) / parseFloat(getComputedStyle(viz.querySelector('.oneblock__track')).width) * 100;
    return { weight, block, fraction, widthPct };
  });
  check(scale.block === 4_000_000, `exhibit block weight should be 4,000,000, got ${scale.block}`);
  check(Math.abs(scale.fraction - scale.weight / scale.block) < 1e-9, `exhibit fraction ${scale.fraction} !== weight/block`);
  check(Math.abs(scale.widthPct - scale.fraction * 100) < 0.6, `exhibit viz fill width ${scale.widthPct}% not to scale (fraction ${scale.fraction})`);
  await shot('exhibit-item');

  // Kiosk mode: full-screen plate
  await page.goto(`${url}/exhibit?kiosk=1&demo=1`);
  await page.getByTestId('kiosk').waitFor();
  await page.getByTestId('kiosk-plate').waitFor();
  await shot('exhibit-kiosk', true);

  // Static machine-native twins (no client JS): fetched straight from the preview server.
  const idx = await (await fetch(`${url}/exhibit/index.json`)).json();
  check(idx.count >= 1 && idx.source === 'bundled' && idx.certified === false, `exhibit index.json shape unexpected: ${JSON.stringify(idx).slice(0, 120)}`);
  check(idx.blockWeightLimitWU === 4_000_000, 'exhibit index blockWeightLimitWU should be 4,000,000');
  const one = await (await fetch(`${url}/exhibit/${idx.items[0].number}.json`)).json();
  check(one.tier === 'fullblock' && one.estimated === true, 'per-item exhibit twin shape unexpected');

  // Atelier: generate → finalize → Mint this → Validate with the same SHA-256
  await page.goto(`${url}/atelier?demo=1`);
  await h1(/Dress your gentleman/);
  await page.getByLabel('Your brief').fill('DJ at a rooftop party');
  await page.getByRole('button', { name: 'noir' }).click();
  await page.getByRole('button', { name: /^Generate/ }).click();
  await page.getByTestId('candidates').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Finalize selected' }).click();
  await page.getByTestId('final').waitFor({ timeout: 20_000 });
  const preview = page.getByRole('img', { name: 'Preview rendered from the exact bytes to be minted' });
  check(await preview.evaluate((img) => img.complete && img.naturalWidth === 1024), 'finalised JPEG did not decode at 1024 px');
  const sha = (await page.getByTestId('final-sha').textContent()).trim();
  await shot('atelier-final');
  await page.getByRole('button', { name: /Mint this/ }).click();
  await h1(/Present your credentials/);
  await page.getByRole('button', { name: 'Connect UniSat' }).click();
  await page.getByRole('button', { name: 'Continue to Validate' }).click();
  await h1(/inspection/);
  const facts = (await page.getByTestId('handoff-facts').textContent()) ?? '';
  check(facts.includes(sha), 'Validate shows the same SHA-256 the Atelier finalised');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.getByText('Approved', { exact: true }).waitFor({ timeout: 15_000 });
  await shot('atelier-handoff-validate');

  // Club sign-in
  await page.goto(`${url}/club?demo=1`);
  await h1(/The Club/);
  await page.getByRole('button', { name: 'Sign in with UniSat' }).click();
  await page.getByTestId('owned').waitFor({ timeout: 15_000 });
  await shot('club-signed-in');

  await context.close();
  check(external.length === 0, `${width}px: demo mode made network requests:\n  ${external.join('\n  ')}`);
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
    const site = await runSite(browser, url, width);
    console.log(`${width}px site: ${site.length} renders OK, no console errors, no network, no horizontal overflow`);
    for (const f of site) console.log(`  ${f.slice(root.length + 1)}`);
    const saved = await runViewport(browser, url, width);
    console.log(`${width}px mint: ${saved.length} screens OK, no console errors, no horizontal overflow`);
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
