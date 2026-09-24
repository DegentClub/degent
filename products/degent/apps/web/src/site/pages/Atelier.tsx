import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { DEFAULT_CONFIG, TIER_LABELS, type Tier } from '@bsh/degent-mint-sdk';
import { errorMessage, useAsync, useSite } from '../context';
import { useDocumentMeta } from '../lib/meta';
import { rulesOk, rulesStatus, type RuleRow, type RulesInput } from '../lib/atelierRules';
import { measureBytes, verifyContent, type Measured } from '../lib/handoff';
import { formatSatsShort, indicativeRevealSats } from '../lib/cost';
import { AtelierError, PLACARDS, type AtelierCandidate, type AtelierJob, type AtelierQuota, type FinalizedContent, type Placard } from '../services/types';
import { useObjectUrl } from '../../components/ui';
import { Icon } from '../components/Icons';
import { Frame, Notice, SectionTitle } from '../components/ui';

export const STYLE_CHIPS = ['party', 'royalty', 'noir', 'space', 'pharaoh', 'rooftop DJ', 'casino', 'samurai', 'cowboy', 'yacht'] as const;

const TIERS: Tier[] = ['standard', 'large', 'fullblock'];

const kb = (b: number) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1000)} KB`);

/** User-facing text for every Atelier error code the contract defines. */
export function atelierErrorText(e: unknown): string {
  if (!(e instanceof AtelierError)) return errorMessage(e);
  switch (e.code) {
    case 'quota_exceeded':
      return `${e.message.includes('quota') ? e.message : 'You have used all of today’s images.'} Your quota resets at 00:00 UTC.`;
    case 'rate_limited':
      return `Too many requests. Try again in ${e.retryAfterSeconds ?? 60} seconds.`;
    case 'cost_cap_reached':
      return 'The Atelier has reached today’s image budget. Generation reopens at 00:00 UTC; uploads still work.';
    case 'provider_unavailable':
      return 'The image provider is unavailable right now. Nothing was charged against your quota. Try again shortly.';
    case 'range_unreachable':
      return 'This source cannot be encoded inside the chosen tier’s byte range. Pick another tier or another image.';
    case 'review_rejected':
      return `The finished image failed the rules review: ${e.message}`;
    case 'validation_failed': {
      const problems = (e.details as { problems?: string[] } | undefined)?.problems;
      return problems?.length ? `${e.message} (${problems.join('; ')})` : e.message;
    }
    case 'not_configured':
      return 'The Atelier is not configured on this site.';
    default:
      return e.message;
  }
}

function RuleIcon({ state }: { state: RuleRow['state'] }) {
  const sym = { pass: '✓', construction: '✓', attested: '✓', fail: '✕', pending: '…' }[state];
  return (
    <span className={`rc__icon rc__icon--${state}`} aria-hidden="true">
      {sym}
    </span>
  );
}

const STATE_WORD: Record<RuleRow['state'], string> = {
  pass: 'passed',
  fail: 'failed',
  construction: 'by construction',
  attested: 'confirmed by you',
  pending: 'pending',
};

export function RulesChecklist({ rows, title = 'Minting Rules', testid = 'rules-checklist' }: { rows: RuleRow[]; title?: string; testid?: string }) {
  return (
    <div className="rc" data-testid={testid}>
      <p className="rc__title">{title}</p>
      <ul className="rc__list">
        {rows.map((r) => (
          <li key={r.id} className={`rc__row is-${r.state}`} data-rule={r.id} data-state={r.state}>
            <RuleIcon state={r.state} />
            <span>
              <span className="rc__name">
                {r.title}
                <span className="sr-only">: {STATE_WORD[r.state]}</span>
              </span>
              <span className="rc__detail">{r.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Seg<T extends string | number>({ legend, value, options, onChange, name, render }: { legend: string; value: T; options: readonly T[]; onChange(v: T): void; name: string; render?(v: T): ReactNode }) {
  return (
    <fieldset className="segf">
      <legend>{legend}</legend>
      <div className="segf__opts">
        {options.map((o) => (
          <label key={String(o)} className={`segf__opt ${o === value ? 'is-on' : ''}`}>
            <input type="radio" name={name} checked={o === value} onChange={() => onChange(o)} />
            <span>{render ? render(o) : String(o)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TierPicker({ value, onChange, name, feeRate }: { value: Tier; onChange(t: Tier): void; name: string; feeRate: number | null }) {
  return (
    <fieldset className="segf">
      <legend>Tier</legend>
      <div className="tierpick">
        {TIERS.map((t) => {
          const rule = DEFAULT_CONFIG.tiers.find((x) => x.tier === t)!;
          return (
            <label key={t} className={`tierpick__opt ${t === value ? 'is-on' : ''}`}>
              <input type="radio" name={name} checked={t === value} onChange={() => onChange(t)} />
              <span className="tierpick__name">{TIER_LABELS[t]}</span>
              <span className="tierpick__range mono">
                {kb(rule.minBytes)}–{kb(rule.maxBytes)}
              </span>
              <span className="tierpick__cost">
                {feeRate ? `≈ ${formatSatsShort(indicativeRevealSats(rule.minBytes, feeRate))}+ at ${feeRate} sat/vB` : 'cost quoted at mint'}
              </span>
            </label>
          );
        })}
      </div>
      {value !== 'standard' ? (
        <p className="small warn-text">
          {value === 'large'
            ? 'Large Degents are non-standard reveals via the block lane: expect a much larger fee than a Standard Degent.'
            : 'A Full Block Degent fills a whole Bitcoin block: its fee is that of an entire block of transactions.'}
        </p>
      ) : null}
    </fieldset>
  );
}

/** The finished bytes: facts, preview from the exact bytes, and "Mint this". */
function FinalPanel({ measured, label, source, rows, onMint }: { measured: Measured; label: string; source: 'atelier' | 'upload'; rows: RuleRow[]; onMint(): void }) {
  const a = measured.artwork;
  const url = useObjectUrl(a.bytes, a.contentType);
  const ok = rulesOk(rows) && measured.tier !== null;
  return (
    <section className="card final" aria-labelledby="final-h" data-testid="final">
      <h2 id="final-h">Ready to mint</h2>
      <div className="final__grid">
        <div className="final__preview">{url ? <img src={url} alt="Preview rendered from the exact bytes to be minted" /> : null}</div>
        <dl className="final__facts">
          <div>
            <dt>Exact bytes</dt>
            <dd className="mono" data-testid="final-bytes">
              {a.size.toLocaleString('en-US')}
            </dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd className="mono mono--wrap" data-testid="final-sha">
              {a.sha256}
            </dd>
          </div>
          <div>
            <dt>Dimensions</dt>
            <dd className="mono">
              {a.width}×{a.height} px
            </dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd className="mono">{a.contentType}</dd>
          </div>
          <div>
            <dt>Tier</dt>
            <dd>{measured.tier ? TIER_LABELS[measured.tier] : <span className="bad-text">outside every tier</span>}</dd>
          </div>
        </dl>
      </div>
      <RulesChecklist rows={rows} title="Rules on these bytes" testid="final-rules" />
      <p className="small muted">
        “Mint this” hands these exact bytes to the mint: it skips Create and opens Validate. Nothing is re-encoded. {source === 'atelier' ? label : ''}
      </p>
      <button type="button" className="cta cta--gradient" onClick={onMint} disabled={!ok}>
        <span>Mint this</span>
        <span className="cta__icon">
          <Icon.rocket />
        </span>
      </button>
      {!ok ? <p className="small bad-text">Every rule must pass (or be confirmed for your own art) and the size must fit a tier.</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ generate

type GenPhase =
  | { k: 'idle' }
  | { k: 'submitting' }
  | { k: 'polling'; job: AtelierJob | null; jobId: string }
  | { k: 'done'; job: AtelierJob }
  | { k: 'failed'; message: string };

function Generate({ pollMs, feeRate }: { pollMs: number; feeRate: number | null }) {
  const { site, sendToMint } = useSite();
  const atelier = site.atelier;
  const ids = { brief: useId(), hint: useId() };
  const [brief, setBrief] = useState('');
  const [styles, setStyles] = useState<string[]>([]);
  const [placard, setPlacard] = useState<Placard>('DEGENT');
  const [tier, setTier] = useState<Tier>('standard');
  const [variations, setVariations] = useState(2);
  const [phase, setPhase] = useState<GenPhase>({ k: 'idle' });
  const [quota, setQuota] = useState<AtelierQuota | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [final, setFinal] = useState<{ measured: Measured; fin: FinalizedContent } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  useEffect(() => {
    if (!atelier.configured) return;
    atelier.ensureSession().then((q) => alive.current && setQuota(q), () => undefined);
  }, [atelier]);

  const fullBrief = `${brief.trim()}${styles.length ? `, ${styles.join(', ')}` : ''}`.slice(0, 200);
  const briefOk = brief.trim().length >= 3 && fullBrief.length <= 200;
  const busy = phase.k === 'submitting' || phase.k === 'polling' || finalizing;

  const generate = async () => {
    setError(null);
    setFinal(null);
    setSelected(null);
    setPhase({ k: 'submitting' });
    try {
      await atelier.ensureSession();
      const r = await atelier.generate({ brief: fullBrief, placard, tier, variations });
      if (!alive.current) return;
      setQuota(r.quota);
      setPhase({ k: 'polling', job: null, jobId: r.jobId });
      for (;;) {
        const job = await atelier.getJob(r.jobId);
        if (!alive.current) return;
        if (job.status === 'done') {
          setPhase({ k: 'done', job });
          if (job.candidates[0]) setSelected(job.candidates[0].id);
          return;
        }
        if (job.status === 'failed') {
          setPhase({ k: 'failed', message: job.error?.message ?? 'The job failed.' });
          atelier.ensureSession().then((q) => alive.current && setQuota(q), () => undefined);
          return;
        }
        setPhase({ k: 'polling', job, jobId: r.jobId });
        await new Promise((res) => setTimeout(res, pollMs));
      }
    } catch (e) {
      if (alive.current) setPhase({ k: 'failed', message: atelierErrorText(e) });
    }
  };

  const finalize = async () => {
    if (!selected) return;
    setFinalizing(true);
    setError(null);
    try {
      const fin = await atelier.finalize(selected, { tier, placard });
      const bytes = await atelier.getContent(fin.contentSha256);
      const measured = verifyContent(bytes, fin.contentSha256, `atelier-${fin.contentSha256.slice(0, 8)}.jpg`);
      if (alive.current) setFinal({ measured, fin });
    } catch (e) {
      if (alive.current) setError(atelierErrorText(e));
    } finally {
      if (alive.current) setFinalizing(false);
    }
  };

  const job = phase.k === 'done' ? phase.job : null;
  const candidate = job?.candidates.find((c) => c.id === selected) ?? null;
  const rulesIn: RulesInput = final
    ? {
        path: 'generate',
        candidate: true,
        review: final.fin.review,
        placard: final.fin.placard,
        final: { contentType: final.measured.artwork.contentType, width: final.measured.artwork.width, height: final.measured.artwork.height, size: final.measured.artwork.size },
      }
    : { path: 'generate', candidate: !!candidate, review: candidate?.review ?? null, placard };
  const rows = rulesStatus(rulesIn);

  if (!atelier.configured) {
    return (
      <Notice tone="warn" title="The Atelier is not configured on this site">
        AI generation needs the Atelier service (<code>VITE_ATELIER_URL</code>). You can still bring your own art below and mint it as is.
      </Notice>
    );
  }

  return (
    <div className="atelier-grid">
      <div className="stack-s">
        <form
          className="card gen-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (briefOk && !busy) void generate();
          }}
        >
          <div className="field-l">
            <label htmlFor={ids.brief} className="field-l__label">
              Your brief
            </label>
            <input
              id={ids.brief}
              value={brief}
              maxLength={200}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. DJ at a rooftop party"
              aria-describedby={ids.hint}
            />
            <span id={ids.hint} className="field-l__hint">
              3–200 characters. The Atelier always paints Pepe in a tuxedo with a bow tie; you choose the scene. {fullBrief.length}/200
            </span>
          </div>
          <fieldset className="segf">
            <legend>Style</legend>
            <div className="chips">
              {STYLE_CHIPS.map((c) => {
                const on = styles.includes(c);
                return (
                  <button key={c} type="button" className={`chip-btn ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => setStyles((s) => (on ? s.filter((x) => x !== c) : [...s, c]))}>
                    {c}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Seg<Placard> legend="Placard" name="gen-placard" value={placard} options={PLACARDS} onChange={setPlacard} />
          <TierPicker value={tier} onChange={setTier} name="gen-tier" feeRate={feeRate} />
          <Seg<number> legend="Variations" name="gen-var" value={variations} options={[1, 2, 3, 4]} onChange={setVariations} />
          <div className="gen-form__foot">
            <button type="submit" className="cta cta--gradient" disabled={!briefOk || busy}>
              <span>{phase.k === 'submitting' ? 'Sending…' : phase.k === 'polling' ? 'Painting…' : 'Generate'}</span>
              <span className="cta__icon">
                <Icon.brush />
              </span>
            </button>
            {quota ? (
              <span className="small muted" data-testid="quota">
                {quota.usedToday} of {quota.dailyImages} images used today
              </span>
            ) : null}
          </div>
        </form>

        <div aria-live="polite" data-testid="gen-status">
          {phase.k === 'polling' ? (
            <p className="status-s">
              <span className="spinner-s" aria-hidden="true" />
              {phase.job?.status === 'running' ? 'The painter is at work…' : 'Your job is queued…'}
            </p>
          ) : null}
          {phase.k === 'failed' ? <Notice tone="bad" title="Generation failed">{phase.message}</Notice> : null}
        </div>

        {job ? (
          <section aria-labelledby="cands-h">
            <h2 id="cands-h" className="h-s">
              Candidates
            </h2>
            <ul className="cands" data-testid="candidates">
              {job.candidates.map((c: AtelierCandidate, i) => (
                <li key={c.id}>
                  <label className={`cand ${selected === c.id ? 'is-on' : ''}`}>
                    <input
                      type="radio"
                      name="candidate"
                      checked={selected === c.id}
                      onChange={() => {
                        setSelected(c.id);
                        setFinal(null);
                      }}
                    />
                    <Frame plaque={placard} caption={`Candidate ${i + 1}`}>
                      <img src={c.previewUrl} alt={`Candidate ${i + 1}: ${job.brief}`} width={512} height={512} loading="lazy" />
                    </Frame>
                  </label>
                  <RulesChecklist rows={rulesStatus({ path: 'generate', candidate: true, review: c.review, placard })} title={`Candidate ${i + 1}`} testid={`cand-rules-${i + 1}`} />
                </li>
              ))}
            </ul>
            <p className="small muted">Previews are 512 px and unframed; finalising adds the gold frame and “{placard}” placard and sizes the JPEG into the {TIER_LABELS[tier]} range.</p>
            <button type="button" className="cta cta--gradient" disabled={!selected || finalizing} onClick={() => void finalize()}>
              <span>{finalizing ? 'Framing…' : 'Finalize selected'}</span>
            </button>
            {error ? <Notice tone="bad" title="Finalize failed">{error}</Notice> : null}
          </section>
        ) : null}

        {final ? (
          <FinalPanel
            measured={final.measured}
            label={`Brief: “${job?.brief ?? ''}”.`}
            source="atelier"
            rows={rows}
            onMint={() =>
              sendToMint({
                artwork: final.measured.artwork,
                tier: final.measured.tier!,
                info: { source: 'atelier', label: `Atelier: “${job?.brief ?? fullBrief}” · ${final.fin.placard ?? ''}` },
              })
            }
          />
        ) : null}
      </div>
      <aside className="atelier-side">
        <RulesChecklist rows={rows} />
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ upload

function Upload({ feeRate }: { feeRate: number | null }) {
  const { site, sendToMint } = useSite();
  const atelier = site.atelier;
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'asis' | 'frame'>('asis');
  const [placard, setPlacard] = useState<Placard>('DEGEN');
  const [tier, setTier] = useState<Tier>('standard');
  const [attest, setAttest] = useState({ design: false, frame: false });
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [framed, setFramed] = useState<{ measured: Measured; fin: FinalizedContent } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const pick = async (f: File | undefined | null) => {
    if (!f) return;
    setError(null);
    setFramed(null);
    setFile(f);
    try {
      setMeasured(measureBytes(new Uint8Array(await f.arrayBuffer()), f.name));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const frameIt = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fin = await atelier.upload(file, { tier, placard, frame: true });
      const bytes = await atelier.getContent(fin.contentSha256);
      setFramed({ measured: verifyContent(bytes, fin.contentSha256, `framed-${file.name.replace(/\.[^.]+$/, '')}.jpg`), fin });
    } catch (e) {
      setError(atelierErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void pick(e.dataTransfer.files?.[0]);
  };

  const asis = measured
    ? rulesStatus({
        path: 'upload-asis',
        final: { contentType: measured.artwork.contentType, width: measured.artwork.width, height: measured.artwork.height, size: measured.artwork.size },
        attest,
      })
    : rulesStatus({ path: 'upload-asis', attest });
  const framedRows = framed
    ? rulesStatus({
        path: 'upload-frame',
        attest,
        review: framed.fin.review,
        placard: framed.fin.placard,
        final: { contentType: framed.measured.artwork.contentType, width: framed.measured.artwork.width, height: framed.measured.artwork.height, size: framed.measured.artwork.size },
      })
    : rulesStatus({ path: 'upload-frame', attest, placard });
  const rows = mode === 'asis' ? asis : framedRows;

  return (
    <div className="atelier-grid">
      <div className="stack-s">
        <div className="card">
          <div
            className={`drop ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            data-testid="dropzone"
          >
            <Icon.upload />
            <p>Drop your image here, or</p>
            <label htmlFor={fileId} className="cta cta--dark cta--sm">
              <span>Choose a file</span>
            </label>
            <input id={fileId} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif" onChange={(e) => void pick(e.target.files?.[0])} aria-label="Choose an image file" />
            {file ? (
              <p className="small mono mono--wrap" data-testid="picked">
                {file.name} · {file.size.toLocaleString('en-US')} bytes
              </p>
            ) : null}
          </div>
          <Seg
            legend="How should we use it?"
            name="up-mode"
            value={mode}
            options={['asis', 'frame'] as const}
            onChange={(m) => setMode(m)}
            render={(m) => (m === 'asis' ? 'Use as-is (exact bytes)' : 'Frame it for me')}
          />
          {mode === 'asis' ? (
            <fieldset className="segf">
              <legend>Confirm for your art</legend>
              <label className="tick">
                <input type="checkbox" checked={attest.design} onChange={(e) => setAttest((a) => ({ ...a, design: e.target.checked }))} />
                <span>It shows Pepe in a tuxedo with a bow tie</span>
              </label>
              <label className="tick">
                <input type="checkbox" checked={attest.frame} onChange={(e) => setAttest((a) => ({ ...a, frame: e.target.checked }))} />
                <span>It is framed, with a DEGEN / DEGENT / REGEN placard</span>
              </label>
              <p className="small muted">Your bytes go to the mint unchanged; the mint's automated review checks them again.</p>
            </fieldset>
          ) : atelier.configured ? (
            <>
              <Seg<Placard> legend="Placard" name="up-placard" value={placard} options={PLACARDS} onChange={setPlacard} />
              <TierPicker value={tier} onChange={setTier} name="up-tier" feeRate={feeRate} />
              <label className="tick">
                <input type="checkbox" checked={attest.design} onChange={(e) => setAttest((a) => ({ ...a, design: e.target.checked }))} />
                <span>It shows Pepe in a tuxedo with a bow tie</span>
              </label>
              <button type="button" className="cta cta--gradient" disabled={!file || busy} onClick={() => void frameIt()}>
                <span>{busy ? 'Framing…' : 'Frame it'}</span>
              </button>
            </>
          ) : (
            <Notice tone="warn" title="Framing needs the Atelier">
              The Atelier service is not configured on this site, so it cannot add the frame. Use your art as-is instead.
            </Notice>
          )}
          {error ? <Notice tone="bad" title="Could not use that file">{error}</Notice> : null}
        </div>
        {mode === 'asis' && measured ? (
          <FinalPanel
            measured={measured}
            label=""
            source="upload"
            rows={asis}
            onMint={() => sendToMint({ artwork: measured.artwork, tier: measured.tier!, info: { source: 'upload', label: `Your file ${measured.artwork.fileName}` } })}
          />
        ) : null}
        {mode === 'frame' && framed ? (
          <FinalPanel
            measured={framed.measured}
            label=""
            source="upload"
            rows={framedRows}
            onMint={() => sendToMint({ artwork: framed.measured.artwork, tier: framed.measured.tier!, info: { source: 'upload', label: `Your art, framed with “${framed.fin.placard}”` } })}
          />
        ) : null}
      </div>
      <aside className="atelier-side">
        <RulesChecklist rows={rows} />
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ page

export function Atelier({ pollMs }: { pollMs?: number }) {
  const { site, mint, app } = useSite();
  useDocumentMeta({ title: 'The Atelier', description: 'Generate a Degent that passes the Minting Rules by construction, or bring your own art, then mint the exact bytes.' });
  const [tab, setTab] = useState<'generate' | 'upload'>('generate');
  const health = useAsync(() => (site.atelier.configured ? site.atelier.health() : Promise.resolve(null)), [site]);
  const fees = useAsync(() => mint.mintApi.getFees(), [mint]);
  const feeRate = fees.status === 'ok' ? fees.value.normal : null;
  const every = pollMs ?? Math.min(app.pollIntervalMs, 2000);

  return (
    <div className="container stack page-top">
      <SectionTitle
        level={1}
        kicker="The Atelier"
        title="Dress your gentleman"
        sub="Describe a scene and the Atelier paints a Degent that meets the Minting Rules by construction: Pepe, tuxedo, bow tie, gold frame and placard. Or bring your own art."
      />
      <div aria-live="polite">
        {site.atelier.configured && health.status === 'ok' && health.value?.provider.mode === 'fake' ? (
          <Notice tone="warn" title="Image provider not configured">
            Candidates are procedural placeholders from the Atelier's fake provider{site.mode === 'demo' ? ' (demo mode, no network)' : ''}. The frame, placard
            and byte sizing are real{site.mode === 'demo' ? ' in the service; this demo composes in your browser' : ''}.
          </Notice>
        ) : null}
        {site.atelier.configured && health.status === 'ok' && health.value?.status === 'degraded' ? (
          <Notice tone="warn" title="The Atelier is busy">
            Today's image budget is nearly or fully spent. Generation may be refused until 00:00 UTC; uploads still work.
          </Notice>
        ) : null}
        {site.atelier.configured && health.status === 'error' ? (
          <Notice tone="bad" title="The Atelier is unreachable">
            {health.error}. You can still use your own art as-is.
          </Notice>
        ) : null}
      </div>
      <div className="tabs" role="tablist" aria-label="Atelier">
        <button type="button" role="tab" id="tab-gen" aria-selected={tab === 'generate'} aria-controls="panel-gen" className={`tab ${tab === 'generate' ? 'is-on' : ''}`} onClick={() => setTab('generate')}>
          Generate with AI
        </button>
        <button type="button" role="tab" id="tab-up" aria-selected={tab === 'upload'} aria-controls="panel-up" className={`tab ${tab === 'upload' ? 'is-on' : ''}`} onClick={() => setTab('upload')}>
          Bring your own art
        </button>
      </div>
      <div role="tabpanel" id="panel-gen" aria-labelledby="tab-gen" hidden={tab !== 'generate'}>
        {tab === 'generate' ? <Generate pollMs={every} feeRate={feeRate} /> : null}
      </div>
      <div role="tabpanel" id="panel-up" aria-labelledby="tab-up" hidden={tab !== 'upload'}>
        {tab === 'upload' ? <Upload feeRate={feeRate} /> : null}
      </div>
    </div>
  );
}
