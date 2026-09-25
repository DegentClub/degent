/**
 * The Full Block Exhibit (learning-ladder rung "Own"): a Full Block Degent presented as a museum
 * object, and the physical limit of Bitcoin it teaches — one artwork that fills nearly a whole
 * 4,000,000 WU block.
 *
 *   /exhibit          gallery of the collection's Full Block Degents (content >= the SDK `fullblock`
 *                     tier floor). Empty and honest when none are certified yet.
 *   /exhibit/:n       one exhibit: a large plate, the one-block visualization drawn to scale, the
 *                     recorded on-chain facts, a museum placard, a curatorial narrative and a
 *                     "why a full block is special" explainer, and deep links to block.space X-Ray /
 *                     Block Theater (ADR-0008), ordinals.com, Ordiscan and Magic Eden.
 *   ?kiosk=1          full-screen, auto-advancing plates for a gallery screen (reduced-motion aware).
 *   ?format=json      the machine-native JSON twin of the page's data.
 *
 * No maths is re-derived here: weight/vsize/lane/tier come from `../lib/exhibit` (which reuses
 * `@bsh/inscription` and `@bsh/degent-mint-sdk`). Counts are certified facts or the bundled
 * (uncertified/demo) manifest, never the retired live-site numbers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRouter } from '../router';
import { useAsync, useSite, type Async } from '../context';
import type { CollectionItem, InscriptionDetails } from '../services/types';
import { useDocumentMeta, useJsonLd, SITE_NAME } from '../lib/meta';
import { indicativeRevealSats } from '../lib/cost';
import { Icon } from '../components/Icons';
import { Cta, DegentImage, Frame, Hero, Notice, Pill, SectionTitle } from '../components/ui';
import { ComicTeaser, ordiscanUrl } from '../components/Sections';
import { magicEdenItemUrl } from '../components/Lightbox';
import {
  BLOCK_WEIGHT_LIMIT,
  FULLBLOCK_MIN_BYTES,
  contentBytesOf,
  estimateReveal,
  exhibitItemJson,
  exhibitIndexJson,
  exhibitLinks,
  feeRateFromFee,
  fullBlockItems,
  type LinkBases,
} from '../lib/exhibit';

// ------------------------------------------------------------------ small format helpers (numbers only)

const nf = (n: number) => n.toLocaleString('en-US');
const pct2 = (frac: number) => `${(frac * 100).toFixed(2)}%`;
function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}
/** An illustrative reveal cost at a fixed fee rate (lesson claim; reuses `indicativeRevealSats`). */
const ILLUSTRATIVE_FEE_RATE = 2;

function useLinkBases(): LinkBases {
  const { app } = useSite();
  return useMemo(
    () => ({ ordinals: app.ordContentUrl, magicEden: 'https://magiceden.io', blockspace: app.blockspaceUrl }),
    [app.ordContentUrl, app.blockspaceUrl],
  );
}

// ------------------------------------------------------------------ the one-block visualization

/**
 * The reveal's weight drawn to scale against one 4,000,000 WU block. The fill's width is exactly the
 * weight fraction of the block, so its area IS the weight (fixed height). Static (no animation), and
 * every number is available as a table twin for screen readers and reduced-motion.
 */
export function OneBlockViz({ contentBytes, compact = false }: { contentBytes: number; compact?: boolean }) {
  const est = estimateReveal(contentBytes);
  const widthPct = `${(est.fraction * 100).toFixed(4)}%`;
  const remainderWU = Math.max(0, BLOCK_WEIGHT_LIMIT - est.weight);
  return (
    <figure
      className={`oneblock ${compact ? 'oneblock--compact' : ''}`.trim()}
      data-testid="one-block-viz"
      data-weight={est.weight}
      data-block-weight={BLOCK_WEIGHT_LIMIT}
      data-fraction={est.fraction}
      role="group"
      aria-label={`This inscription's reveal weighs about ${nf(est.weight)} weight units, ${pct2(est.fraction)} of one ${nf(BLOCK_WEIGHT_LIMIT)} WU Bitcoin block.`}
    >
      <div className="oneblock__track" aria-hidden="true">
        <div className="oneblock__fill" data-testid="oneblock-fill" style={{ width: widthPct }}>
          <span className="oneblock__fill-label">{pct2(est.fraction)} of one block</span>
        </div>
        <span className="oneblock__cap">4,000,000 WU</span>
      </div>
      <figcaption className="oneblock__caption small muted">
        The green area is this inscription's reveal weight to scale; the whole bar is one Bitcoin block (4,000,000 WU
        consensus limit). Weight is estimated from the content length.
      </figcaption>
      <table className="oneblock__twin" data-testid="oneblock-twin">
        <caption className="sr-only">One-block visualization, as numbers</caption>
        <tbody>
          <tr>
            <th scope="row">Reveal weight (estimated)</th>
            <td className="mono">{nf(est.weight)} WU</td>
          </tr>
          <tr>
            <th scope="row">Block weight limit</th>
            <td className="mono">{nf(BLOCK_WEIGHT_LIMIT)} WU</td>
          </tr>
          <tr>
            <th scope="row">Share of one block</th>
            <td className="mono">{pct2(est.fraction)}</td>
          </tr>
          <tr>
            <th scope="row">Unused in the block</th>
            <td className="mono">{nf(remainderWU)} WU</td>
          </tr>
        </tbody>
      </table>
    </figure>
  );
}

// ------------------------------------------------------------------ facts, placard, links (detail)

const FACT_ROWS: Array<{ label: string; render(d: InscriptionDetails | null): string }> = [
  { label: 'Timestamp', render: (d) => fmtTime(d?.timestamp ?? null) },
  { label: 'Block height', render: (d) => (d?.height != null ? nf(d.height) : '—') },
  { label: 'Held by', render: (d) => d?.address ?? '—' },
];

function ExhibitFacts({ item, details }: { item: CollectionItem; details: Async<InscriptionDetails | null> }) {
  const contentBytes = contentBytesOf(item) ?? 0;
  const est = estimateReveal(contentBytes);
  const d = details.status === 'ok' ? details.value : null;
  const feeSats = d?.fee ?? null;
  const feeRate = feeRateFromFee(feeSats, est.vsize);
  const illustrative = indicativeRevealSats(contentBytes, ILLUSTRATIVE_FEE_RATE);
  return (
    <div className="exhibit-facts">
      <dl className="lb-facts" data-testid="exhibit-facts" aria-busy={details.status === 'loading'}>
        <div className="lb-facts__row">
          <dt>Content bytes</dt>
          <dd className="mono" data-testid="fact-content-bytes">{nf(contentBytes)} bytes · {mb(contentBytes)}</dd>
        </div>
        <div className="lb-facts__row">
          <dt>Reveal weight (est.)</dt>
          <dd className="mono" data-testid="fact-weight">{nf(est.weight)} WU</dd>
        </div>
        <div className="lb-facts__row">
          <dt>Reveal vsize (est.)</dt>
          <dd className="mono">{nf(est.vsize)} vB</dd>
        </div>
        <div className="lb-facts__row">
          <dt>Share of a block</dt>
          <dd className="mono" data-testid="fact-fraction">{pct2(est.fraction)} of 4,000,000 WU</dd>
        </div>
        <div className="lb-facts__row">
          <dt>Lane</dt>
          <dd className="mono">block (a whole block to itself)</dd>
        </div>
        <div className="lb-facts__row">
          <dt>Fee paid</dt>
          <dd className="mono" data-testid="fact-fee">
            {details.status === 'loading'
              ? '…'
              : feeSats != null
                ? `${nf(feeSats)} sats${feeRate != null ? ` (≈ ${feeRate.toFixed(2)} sat/vB)` : ''}`
                : '—'}
          </dd>
        </div>
      </dl>
      <p className="small muted">
        Reveal weight, vsize and block share are estimated from the content length with{' '}
        <code>@bsh/inscription</code>; content bytes come from the collection membership. Timestamp, block height, address and fee
        come from the ord JSON API. At {ILLUSTRATIVE_FEE_RATE} sat/vB a reveal this size costs ≈ {nf(illustrative)} sats
        (illustrative — see the explainer).
      </p>
    </div>
  );
}

function Placard({ item, details, mode }: { item: CollectionItem; details: Async<InscriptionDetails | null>; mode: 'live' | 'demo' }) {
  const d = details.status === 'ok' ? details.value : null;
  return (
    <aside className="placard" aria-labelledby="placard-h" id="placard">
      <p className="placard__eyebrow">Decentralized Gentlemen Club · Full Block Degent</p>
      <h2 id="placard-h" className="placard__title">{item.name}</h2>
      <dl className="placard__dl">
        <div>
          <dt>Inscription</dt>
          <dd className="mono mono--wrap" data-testid="placard-id">{item.id}</dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>
            Parent-linked collection membership, verifiable on any ord indexer.{' '}
            <a href={ordiscanUrl(item.id)} target="_blank" rel="noopener noreferrer">
              View provenance on Ordiscan<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </dd>
        </div>
        <div>
          <dt>Inscribed</dt>
          <dd className="mono">{fmtTime(d?.timestamp ?? null)}{details.status === 'loading' ? ' …' : ''}</dd>
        </div>
      </dl>
      <p className="small muted">
        Facts from the ord JSON API{mode === 'demo' ? ' (demo fixtures — no network)' : ''}. Membership from block.space certification.
      </p>
    </aside>
  );
}

function ExhibitLinksRow({ item, details }: { item: CollectionItem; details: Async<InscriptionDetails | null> }) {
  const bases = useLinkBases();
  const height = details.status === 'ok' ? (details.value?.height ?? null) : null;
  const links = exhibitLinks(item, height, bases);
  return (
    <div className="cta-row cta-row--wrap" data-testid="exhibit-links">
      {links.xray ? (
        <Cta href={links.xray} variant="gradient" className="cta--sm">View in X-Ray</Cta>
      ) : null}
      {links.theater ? (
        <Cta href={links.theater} variant="dark" className="cta--sm">View in Block Theater</Cta>
      ) : (
        <span className="small muted" data-testid="theater-pending">Block Theater link appears once the block height is known.</span>
      )}
      <Cta href={links.ordinals} variant="dark" className="cta--sm">View on Ordinals.com</Cta>
      <Cta href={ordiscanUrl(item.id)} variant="dark" className="cta--sm">Ordiscan</Cta>
      <Cta href={magicEdenItemUrl(item.id)} variant="dark" className="cta--sm">
        <span>Buy</span>
        <span className="cta__icon"><Icon.cart /></span>
      </Cta>
    </div>
  );
}

// ------------------------------------------------------------------ narrative + explainer

function WhyFullBlock({ contentBytes }: { contentBytes: number }) {
  const est = estimateReveal(contentBytes);
  const cost = indicativeRevealSats(contentBytes, ILLUSTRATIVE_FEE_RATE);
  return (
    <section className="explainer" aria-labelledby="why-h" id="why">
      <SectionTitle title="Why a full block is special" id="why-h" />
      <ul className="explainer__list">
        <li>
          <strong>A block holds 4,000,000 weight units.</strong> That is Bitcoin's consensus limit on a block
          (<code>@bsh/inscription</code> <code>LIMITS.MAX_BLOCK_WEIGHT</code>). Nothing on chain can exceed it.
        </li>
        <li>
          <strong>Witness bytes are discounted.</strong> A non-witness byte weighs 4 WU, a witness byte 1 WU. An
          inscription's content rides in the witness, so ~3.96 MB of image fits inside one 4,000,000 WU block —
          which is how the collection's largest Degents were made.
        </li>
        <li>
          <strong>One per block, by construction.</strong> A Full Block Degent's reveal alone is{' '}
          <span className="mono">{nf(est.weight)} WU</span> ({pct2(est.fraction)} of the block), so nothing else fits
          beside it — the mint gives it a whole block slot to itself (ADR-0005 §3–§4).
        </li>
        <li>
          <strong>It costs what a block costs.</strong> Fee = vsize × fee rate. This reveal is{' '}
          <span className="mono">{nf(est.vsize)} vB</span>; at {ILLUSTRATIVE_FEE_RATE} sat/vB that is{' '}
          <span className="mono">≈ {nf(cost)} sats</span> (illustrative). Filling a block is buying a block's worth of
          space.
        </li>
      </ul>
      <p className="small muted">
        Consensus facts cited from <code>@bsh/inscription</code> and ADR-0005; the weight-proportional method mirrors
        block.space's Block Theater (ADR-0008). Illustrative figures are labelled; they are not a price or a quote.
      </p>
    </section>
  );
}

function CuratorialNote() {
  const { app } = useSite();
  return (
    <section className="curatorial card" aria-labelledby="curatorial-h" id="narrative">
      <Pill>Curatorial note</Pill>
      <h2 id="curatorial-h">A gentleman the size of a block</h2>
      {/* The Degent Chronicles copy was not captured; never invented (docs/site-spec.md). */}
      <p data-testid="curatorial-todo">
        TODO(copy): tie this exhibit to the Degent Chronicles comic — the lore of a gentleman inscribed at the scale
        of an entire Bitcoin block. The captured site did not include the comic's text, so the narrative is left as a
        placeholder rather than invented.
      </p>
      <div className="cta-row">
        <Cta to="/comic">Read the Comic</Cta>
        {app.comicInscriptionId ? (
          <Cta href={ordiscanUrl(app.comicInscriptionId)} variant="dark">View in Ordiscan</Cta>
        ) : null}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ kiosk mode

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Full-screen auto-advancing plates for a gallery screen or booth. */
function Kiosk({ items, advanceMs = 8000 }: { items: CollectionItem[]; advanceMs?: number }) {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const n = items.length;
  const go = useCallback((d: number) => setI((prev) => (n === 0 ? 0 : (prev + d + n) % n)), [n]);
  useEffect(() => {
    if (reduced || n <= 1) return; // reduced motion: no auto-advance, manual only
    const t = setInterval(() => setI((prev) => (prev + 1) % n), advanceMs);
    return () => clearInterval(t);
  }, [reduced, n, advanceMs]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go]);

  const item = items[i] ?? null;
  return (
    <section className="kiosk" data-testid="kiosk" aria-label="Full Block Exhibit kiosk">
      <div className="kiosk__top">
        <span className="kiosk__brand">degent<span className="accent">.club</span> · Full Block Exhibit</span>
        <Link to="/exhibit" className="kiosk__exit">Exit kiosk</Link>
      </div>
      {item ? (
        <div className="kiosk__plate" key={item.id} data-testid="kiosk-plate">
          <div className="kiosk__art">
            <Frame plaque="DEGEN">
              <DegentImage item={item} eager />
            </Frame>
          </div>
          <div className="kiosk__side">
            <p className="kiosk__eyebrow">Full Block Degent</p>
            <h1 className="kiosk__title">{item.name}</h1>
            <OneBlockViz contentBytes={contentBytesOf(item) ?? 0} />
            <p className="kiosk__count small muted">{i + 1} / {n}{reduced ? ' · reduced motion: use ← →' : ''}</p>
          </div>
        </div>
      ) : (
        <p className="kiosk__empty">No Full Block Degents to show yet.</p>
      )}
      <div className="kiosk__controls">
        <button type="button" className="iconbtn" onClick={() => go(-1)} aria-label="Previous plate"><Icon.chevronLeft /></button>
        <button type="button" className="iconbtn" onClick={() => go(1)} aria-label="Next plate"><Icon.chevronRight /></button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ JSON twin (?format=json)

function JsonTwin({ data }: { data: unknown }) {
  const json = JSON.stringify(data, null, 2);
  return (
    <div className="container page-top">
      <p className="small muted">
        Machine-native JSON twin. See also <span className="mono">/exhibit/index.json</span> and per-item{' '}
        <span className="mono">/exhibit/&lt;n&gt;.json</span>.
      </p>
      <pre className="json-twin" data-testid="json-twin">{json}</pre>
    </div>
  );
}

// ------------------------------------------------------------------ detail page

function ExhibitDetail({ item, siblings, missingNumber }: { item: CollectionItem | null; siblings: CollectionItem[]; missingNumber: number }) {
  const { site, app } = useSite();
  const bases = useLinkBases();
  const details = useAsync(() => (item ? site.ord.getInscription(item.id) : Promise.resolve(null)), [item?.id, site]);
  const idx = item ? siblings.findIndex((s) => s.number === item.number) : -1;
  const prev = idx > 0 ? siblings[idx - 1]! : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1]! : null;
  const contentBytes = item ? contentBytesOf(item) ?? 0 : 0;

  useDocumentMeta(
    item
      ? {
          title: `${item.name} — Full Block Exhibit`,
          description: `${item.name}: a Full Block Degent, ${pct2(estimateReveal(contentBytes).fraction)} of one Bitcoin block. Inscription ${item.id}.`,
          ...(site.mode === 'live' ? { image: site.ord.contentUrl(item.id) } : {}),
        }
      : { title: `Exhibit #${missingNumber}`, description: 'Full Block Exhibit.' },
  );
  const jsonld = useMemo(() => {
    if (!item) return null;
    const est = estimateReveal(contentBytes);
    const links = exhibitLinks(item, details.status === 'ok' ? details.value?.height ?? null : null, bases);
    return {
      '@context': 'https://schema.org',
      '@type': 'VisualArtwork',
      name: item.name,
      identifier: item.id,
      artform: 'Bitcoin Ordinal inscription',
      artMedium: 'image/jpeg',
      contentSize: `${contentBytes} B`,
      size: `${est.weight} WU (~${pct2(est.fraction)} of one 4,000,000 WU Bitcoin block; reveal weight estimated)`,
      url: links.ordinals,
      isPartOf: { '@type': 'CreativeWork', name: 'Decentralized Gentlemen Club', url: `https://${SITE_NAME}/collection` },
      citation: {
        '@type': 'CreativeWork',
        name: 'Bitcoin block weight limit (4,000,000 WU)',
        ...(links.theater ? { url: links.theater } : {}),
      },
    };
  }, [item?.id, contentBytes, details.status, bases]); // eslint-disable-line react-hooks/exhaustive-deps
  useJsonLd(jsonld);

  if (!item) {
    return (
      <div className="container stack page-top narrow">
        <SectionTitle level={1} kicker="Full Block Exhibit" title={`Exhibit #${missingNumber}`} />
        <Notice tone="warn" title="Not in the exhibit">
          Degent #{missingNumber} is not a Full Block Degent, or is not in the certified membership list. The exhibit only
          shows Degents whose content is at least {nf(FULLBLOCK_MIN_BYTES / 1_000_000)} MB.
        </Notice>
        <div className="cta-row">
          <Cta to="/exhibit" variant="dark">Back to the exhibit</Cta>
          <Cta to="/collection" variant="dark">The whole collection</Cta>
        </div>
      </div>
    );
  }

  return (
    <div className="container stack page-top">
      <nav className="exhibit-breadcrumb small" aria-label="Breadcrumb">
        <Link to="/exhibit">Full Block Exhibit</Link> <span aria-hidden="true">/</span> {item.name}
      </nav>

      <section className="exhibit-detail" aria-labelledby="ex-h" id="plate">
        <div className="exhibit-detail__plate">
          <Frame plaque="DEGEN" caption={item.name}>
            <DegentImage item={item} eager />
          </Frame>
        </div>
        <div className="exhibit-detail__meta">
          <Pill>Full Block Degent</Pill>
          <h1 id="ex-h" className="exhibit-detail__title" tabIndex={-1}>{item.name}</h1>
          <p className="exhibit-detail__lede">
            One artwork, {mb(contentBytes)} of it, filling {pct2(estimateReveal(contentBytes).fraction)} of a single
            Bitcoin block.
          </p>
          <div id="one-block">
            <OneBlockViz contentBytes={contentBytes} />
          </div>
          <div id="facts">
            <ExhibitFacts item={item} details={details} />
          </div>
          <ExhibitLinksRow item={item} details={details} />
        </div>
      </section>

      <Placard item={item} details={details} mode={site.mode} />
      <CuratorialNote />
      <WhyFullBlock contentBytes={contentBytes} />

      <div className="exhibit-detail__nav cta-row">
        {prev ? <Cta to={`/exhibit/${prev.number}`} variant="dark"><span>← {prev.name}</span></Cta> : null}
        {next ? <Cta to={`/exhibit/${next.number}`} variant="dark"><span>{next.name} →</span></Cta> : null}
        <Cta href={`?format=json`} variant="dark" className="cta--sm">JSON twin</Cta>
      </div>
      <p className="small muted">
        Machine-native: <a href="index.json">/exhibit/index.json</a>, this item at <a href={`${item.number}.json`}>/exhibit/{item.number}.json</a>,
        and <a href="?format=json">?format=json</a>. Reveal weight is estimated (labelled); counts are{' '}
        {app.demo ? 'the bundled manifest (uncertified, demo)' : 'from block.space certification'}.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ list page

function ExhibitGallery({ items, source }: { items: CollectionItem[]; source: 'certified' | 'bundled' }) {
  const bases = useLinkBases();
  const { app } = useSite();
  useDocumentMeta({
    title: 'Full Block Exhibit',
    description: 'The Full Block Degents: single artworks that each fill nearly a whole Bitcoin block. See the physical limit of the chain to scale.',
  });
  const jsonld = useMemo(
    () => ({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      name: 'Full Block Exhibit — Decentralized Gentlemen Club',
      description: 'Full Block Degents, each filling nearly a whole 4,000,000 WU Bitcoin block.',
      url: `https://${SITE_NAME}/exhibit`,
      hasPart: items.slice(0, 20).map((it) => ({ '@type': 'VisualArtwork', name: it.name, identifier: it.id, url: exhibitLinks(it, null, bases).ordinals })),
    }),
    [items, bases],
  );
  useJsonLd(jsonld);

  return (
    <>
      <Hero
        kicker="Own · the peak"
        title={<>The Full Block <span className="accent">Exhibit</span></>}
        sub="One Degent can fill nearly a whole Bitcoin block. These are those Degents — each a single artwork the size of the chain's hard limit, drawn to scale."
        wall={items.slice(0, 18)}
      >
        <Cta href="?kiosk=1" variant="gradient" icon={<Icon.grid />}>Kiosk mode</Cta>
        <Cta to="/collection" variant="dark">The whole collection</Cta>
      </Hero>

      <div className="container stack">
        <section aria-labelledby="ex-gallery-h">
          <SectionTitle
            title="Full Block Degents"
            id="ex-gallery-h"
            sub={`Content at or above ${nf(FULLBLOCK_MIN_BYTES / 1_000_000)} MB — the mint's "fullblock" tier floor. A whole block to each.`}
          />
          <p className="small muted" data-testid="exhibit-source">
            {source === 'certified'
              ? `Membership: block.space certified list. ${items.length} Full Block Degent${items.length === 1 ? '' : 's'}.`
              : `Membership: bundled manifest (not certified${app.demo ? ', demo' : ''}). ${items.length} Full Block Degent${items.length === 1 ? '' : 's'}.`}
          </p>
          <ul className="exhibit-grid" data-testid="exhibit-grid">
            {items.map((it) => {
              const est = estimateReveal(contentBytesOf(it) ?? 0);
              return (
                <li key={it.id}>
                  <Link to={`/exhibit/${it.number}`} className="exhibit-card" aria-label={`${it.name}, ${pct2(est.fraction)} of a block — open exhibit`}>
                    <Frame plaque="DEGEN" caption={it.name}>
                      <DegentImage item={it} />
                    </Frame>
                    <div className="exhibit-card__viz">
                      <OneBlockViz contentBytes={contentBytesOf(it) ?? 0} compact />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        <WhyFullBlock contentBytes={contentBytesOf(items[0]!) ?? FULLBLOCK_MIN_BYTES} />
        <ComicTeaser />
      </div>
    </>
  );
}

function EmptyExhibit({ source }: { source: 'certified' | 'bundled' }) {
  const { app } = useSite();
  useDocumentMeta({ title: 'Full Block Exhibit', description: 'The Full Block Exhibit: single artworks that each fill nearly a whole Bitcoin block.' });
  return (
    <>
      <Hero
        kicker="Own · the peak"
        title={<>The Full Block <span className="accent">Exhibit</span></>}
        sub="One Degent can fill nearly a whole Bitcoin block — the chain's hard limit, made into a single artwork."
        wall={[]}
      >
        <Cta to="/collection" variant="dark">The whole collection</Cta>
        <Cta to="/how-it-works" variant="dark">How minting works</Cta>
      </Hero>
      <div className="container stack">
        <Notice tone="info" title="No Full Block Degents certified yet">
          <p data-testid="exhibit-empty">
            {source === 'certified'
              ? 'The certified membership list has no Full Block Degents yet — none whose content reaches the '
              : `The ${app.demo ? 'demo ' : ''}bundled manifest has no Full Block Degents — none whose content reaches the `}
            {nf(FULLBLOCK_MIN_BYTES / 1_000_000)} MB <code>fullblock</code> tier floor. When one is minted and certified, it
            will appear here as a museum object with its one-block visualization. We do not show placeholder or invented items.
          </p>
        </Notice>
        <WhyFullBlock contentBytes={FULLBLOCK_MIN_BYTES} />
        <ComicTeaser />
      </div>
    </>
  );
}

export function Exhibit({ n }: { n: number | null }) {
  const { site } = useSite();
  const bases = useLinkBases();
  const { search } = useRouter();
  const params = new URLSearchParams(search);
  const format = params.get('format');
  const kiosk = params.get('kiosk') === '1' || params.get('kiosk') === 'true';

  const list = useAsync(() => site.collection.list(), [site]);
  const source = list.status === 'ok' ? list.value.source : 'bundled';
  const full = useMemo(() => (list.status === 'ok' ? fullBlockItems(list.value.items) : []), [list.status, list.status === 'ok' ? list.value : null]);

  if (list.status === 'loading') return <div className="container page-top"><p className="muted">Loading the exhibit…</p></div>;
  if (list.status === 'error') return <div className="container page-top"><Notice tone="bad" title="Could not load the collection">{list.error}</Notice></div>;

  // JSON twin of the page's data (?format=json).
  if (format === 'json') {
    if (n === null) return <JsonTwin data={exhibitIndexJson(list.value, bases)} />;
    const it = full.find((x) => x.number === n) ?? null;
    return <JsonTwin data={it ? exhibitItemJson(it, bases) : { error: { code: 'not_found', message: `Degent #${n} is not a Full Block Degent` } }} />;
  }

  if (kiosk && n === null) return <Kiosk items={full} />;

  if (n !== null) {
    const it = full.find((x) => x.number === n) ?? null;
    return <ExhibitDetail item={it} siblings={full} missingNumber={n} />;
  }

  if (full.length === 0) return <EmptyExhibit source={source} />;
  return <ExhibitGallery items={full} source={source} />;
}
