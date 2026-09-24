/**
 * The Atelier (Create step): upload a picture or start from a template, crop it square, set the gold frame and
 * the placard, and let the browser compose the JPEG. A size-target slider (inside the chosen tier's byte range
 * from @bsh/degent-mint-sdk) drives a binary search on the bytes `canvas.toBlob` really returns. The readout
 * shows the exact reveal vbytes and fee from @bsh/inscription, and which of the four Minting Rules hold.
 *
 * No server-side AI frame generation here (the legacy combiner's `/api/generate-frame` is the reference for a
 * follow-up); everything happens in this tab.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { sniffContentType } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { tierRule } from '../lib/rules';
import { formatBytesExact, formatFeeRate, formatSize, groupDigits } from '../lib/format';
import { estimateReveal } from '../lib/revealEstimate';
import {
  DEFAULT_CROP,
  DEFAULT_OUTPUT_SIZE,
  FRAME_DEFAULT_PCT,
  FRAME_MAX_PCT,
  FRAME_MIN_PCT,
  OUTPUT_SIZES,
  PLACARD_TEXTS,
  clampFramePct,
  layoutComposition,
  type CropState,
  type PlacardText,
} from '../atelier/composition';
import { clampTarget, searchJpegSize, type SizeSearchStatus } from '../atelier/sizeSearch';
import { mintingRules } from '../atelier/mintingRules';
import { TEMPLATES, type SourceImage, type TemplateId } from '../services/types';
import { Alert, Badge, Button, Money, errorText, useObjectUrl } from './ui';

interface Source {
  src: SourceImage;
  name: string;
}

interface Result {
  bytes: Uint8Array;
  size: number;
  quality: number;
  status: SizeSearchStatus;
  width: number;
  height: number;
  /** Inputs this result was made from, to tell a stale preview from a fresh one. */
  key: string;
}

const STATUS_COPY: Record<Exclude<SizeSearchStatus, 'fit'>, string> = {
  'too-small': 'Even at top quality this design is below the target. Pick a larger output size or a more detailed picture.',
  'too-large': 'Even at the lowest quality this design is above the tier maximum. Pick a smaller output size.',
  'no-fit': 'No quality step lands inside the tier range for this design. Nudge the target or the output size.',
};

export function Atelier() {
  const { state, dispatch, services, app } = useMint();
  const config = state.config!;
  const rule = tierRule(config, state.tier);
  const ids = { file: useId(), zoom: useId(), panX: useId(), panY: useId(), frame: useId(), size: useId(), target: useId() };

  const [source, setSource] = useState<Source | null>(null);
  const [crop, setCrop] = useState<CropState>(DEFAULT_CROP);
  const [framePct, setFramePct] = useState(FRAME_DEFAULT_PCT);
  const [placard, setPlacard] = useState<PlacardText>('DEGENT');
  const [outputPx, setOutputPx] = useState<number>(DEFAULT_OUTPUT_SIZE);
  const [target, setTarget] = useState(() => Math.round((rule.minBytes + rule.maxBytes) / 2));
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<'reading' | 'composing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  // A new tier moves the target into its range.
  useEffect(() => {
    setTarget((t) => clampTarget({ minBytes: rule.minBytes, maxBytes: rule.maxBytes, targetBytes: t }));
  }, [rule.minBytes, rule.maxBytes]);

  const key = source ? JSON.stringify([source.name, crop, framePct, placard, outputPx, target, rule.minBytes, rule.maxBytes]) : '';

  // Compose + size search, debounced; stale runs are dropped.
  useEffect(() => {
    if (!source) return;
    const my = ++req.current;
    const t = setTimeout(async () => {
      setBusy('composing');
      setError(null);
      try {
        const layout = layoutComposition(source.src.width, source.src.height, { size: outputPx, framePct, placard, crop });
        const canvas = await services.images.compose(source.src, layout);
        const found = await searchJpegSize((q) => canvas.toBlob('image/jpeg', q), { minBytes: rule.minBytes, maxBytes: rule.maxBytes, targetBytes: target });
        const bytes = new Uint8Array(await found.blob.arrayBuffer());
        if (my !== req.current) return;
        setResult({ bytes, size: bytes.length, quality: found.quality, status: found.status, width: canvas.width, height: canvas.height, key });
      } catch (e) {
        if (my === req.current) setError(errorText(e));
      } finally {
        if (my === req.current) setBusy(null);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [source, crop, framePct, placard, outputPx, target, rule.minBytes, rule.maxBytes, services, key]);

  const load = async (file: Blob, name: string) => {
    setBusy('reading');
    setError(null);
    try {
      const src = await services.images.decode(file);
      setSource({ src, name });
      setCrop(DEFAULT_CROP);
    } catch (e) {
      setError(`Could not read that picture: ${errorText(e)}`);
      setBusy(null);
    }
  };

  const startFrom = async (id: TemplateId) => {
    setBusy('reading');
    setError(null);
    try {
      const src = await services.images.template(id);
      setSource({ src, name: `template:${id}` });
      setCrop(DEFAULT_CROP);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  const previewUrl = useObjectUrl(result?.bytes ?? null, 'image/jpeg');
  const contentType = result ? (sniffContentType(result.bytes) ?? 'image/jpeg') : 'image/jpeg';
  const rules = mintingRules({
    artwork: result ? { contentType, width: result.width, height: result.height, size: result.size } : null,
    tier: state.tier,
    config,
    framing: { framePct, placard },
    briefAck: state.briefAck,
  });
  const feeRate = state.fees?.normal ?? config.minFeeRate;
  const reveal = useMemo(() => {
    if (!result) return null;
    try {
      return estimateReveal({
        contentType,
        bodyLength: result.size,
        parentId: config.parentInscriptionId,
        network: app.network,
        recipientAddress: state.wallet?.ordinals.address ?? null,
        collectionAddress: 'collectionAddress' in config ? (config as { collectionAddress: string }).collectionAddress : null,
        feeRate,
        postageSats: config.postageSats,
      });
    } catch {
      return null;
    }
  }, [result, contentType, config, app.network, state.wallet, feeRate]);
  const usable = !!result && result.status === 'fit' && busy === null && result.key === key;
  const used = !!result && state.artwork?.origin === 'atelier' && state.artwork.bytes === result.bytes;

  const use = () => {
    if (!result) return;
    dispatch({
      type: 'ARTWORK_READY',
      artwork: {
        fileName: `degent-${placard.toLowerCase()}.jpg`,
        bytes: result.bytes,
        contentType,
        size: result.size,
        width: result.width,
        height: result.height,
        sha256: services.inscription.sha256Hex(result.bytes),
        origin: 'atelier',
        quality: result.quality,
        framing: { framePct, placard },
      },
    });
    // The placard carries the word the brief asks for.
    dispatch({ type: 'BRIEF_TOGGLED', id: 'text', checked: true });
  };

  return (
    <div className="atelier" data-testid="atelier">
      <div className="atelier__start">
        <label htmlFor={ids.file} className="btn btn--secondary">
          Upload a picture
        </label>
        <input
          id={ids.file}
          className="sr-only"
          type="file"
          accept="image/*"
          aria-label="Upload a picture for the Atelier"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void load(f, f.name);
          }}
        />
        <span className="small muted">or start from a template:</span>
        {TEMPLATES.map((t) => (
          <Button key={t.id} variant="ghost" onClick={() => void startFrom(t.id)}>
            {t.label}
          </Button>
        ))}
      </div>
      <p className="small muted">Templates are backdrops: the gentleman in his tuxedo and bowtie is still yours to paint in (rule 2).</p>

      {source ? (
        <div className="atelier__grid">
          <div className="atelier__stage">
            <div className="atelier__frame-preview">
              {previewUrl ? (
                <img src={previewUrl} alt={`Atelier preview: the exact JPEG, framed, placard ${placard}`} />
              ) : (
                <div className="atelier__placeholder" aria-hidden="true" />
              )}
            </div>
            <p aria-live="polite" className="small muted">
              {busy === 'reading' ? 'Reading your picture…' : busy === 'composing' ? 'Composing and fitting the size…' : result ? 'Preview rendered from the exact bytes.' : ''}
            </p>
          </div>

          <div className="atelier__controls">
            <fieldset className="atelier__group">
              <legend className="label">Crop (square)</legend>
              <div className="field">
                <label htmlFor={ids.zoom} className="label">
                  Zoom <span className="mono">{crop.zoom.toFixed(2)}×</span>
                </label>
                <input id={ids.zoom} type="range" min={1} max={4} step={0.05} value={crop.zoom} onChange={(e) => setCrop({ ...crop, zoom: Number(e.currentTarget.value) })} />
              </div>
              <div className="field">
                <label htmlFor={ids.panX} className="label">
                  Horizontal position
                </label>
                <input id={ids.panX} type="range" min={-1} max={1} step={0.02} value={crop.panX} onChange={(e) => setCrop({ ...crop, panX: Number(e.currentTarget.value) })} />
              </div>
              <div className="field">
                <label htmlFor={ids.panY} className="label">
                  Vertical position
                </label>
                <input id={ids.panY} type="range" min={-1} max={1} step={0.02} value={crop.panY} onChange={(e) => setCrop({ ...crop, panY: Number(e.currentTarget.value) })} />
              </div>
            </fieldset>

            <fieldset className="atelier__group">
              <legend className="label">Gold frame</legend>
              <div className="field">
                <label htmlFor={ids.frame} className="label">
                  Frame width <span className="mono">{framePct}%</span>
                </label>
                <input
                  id={ids.frame}
                  type="range"
                  min={FRAME_MIN_PCT}
                  max={FRAME_MAX_PCT}
                  step={1}
                  value={framePct}
                  aria-valuetext={`${framePct} percent of the edge`}
                  onChange={(e) => setFramePct(clampFramePct(Number(e.currentTarget.value)))}
                />
              </div>
              <div role="radiogroup" aria-label="Placard text" className="seg">
                {PLACARD_TEXTS.map((t) => (
                  <label key={t} className={placard === t ? 'is-on' : ''}>
                    <input type="radio" name="placard" value={t} checked={placard === t} onChange={() => setPlacard(t)} />
                    {t}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="atelier__group">
              <legend className="label">Output (JPEG)</legend>
              <div className="field">
                <label htmlFor={ids.size} className="label">
                  Size in pixels
                </label>
                <select id={ids.size} value={String(outputPx)} onChange={(e) => setOutputPx(Number(e.currentTarget.value))}>
                  {OUTPUT_SIZES.map((s) => (
                    <option key={s} value={String(s)}>
                      {s} × {s}px
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={ids.target} className="label">
                  Target file size <span className="mono">{formatSize(target)}</span>
                </label>
                <input
                  id={ids.target}
                  type="range"
                  min={rule.minBytes}
                  max={rule.maxBytes}
                  step={1000}
                  value={target}
                  aria-valuetext={formatSize(target)}
                  onChange={(e) => setTarget(Number(e.currentTarget.value))}
                />
                <p className="small muted">
                  {rule.label}: {formatSize(rule.minBytes)} – {formatSize(rule.maxBytes)}. The browser searches JPEG quality until the real file is as large as possible without passing the target.
                </p>
              </div>
            </fieldset>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="atelier__readout" aria-live="polite" data-testid="atelier-readout">
          <dl className="facts facts--inline">
            <div className="fact">
              <dt>File</dt>
              <dd>
                <span className="mono">{formatSize(result.size)}</span> <span className="muted small">({formatBytesExact(result.size)}, JPEG quality {Math.round(result.quality * 100)}%)</span>
              </dd>
            </div>
            <div className="fact">
              <dt>Reveal</dt>
              <dd>
                {reveal ? (
                  <>
                    <span className="mono">{groupDigits(reveal.vsize)} vB</span> <span className="muted small">({groupDigits(reveal.weight)} WU, exact)</span>
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div className="fact">
              <dt>Network fee at {formatFeeRate(feeRate)}</dt>
              <dd>{reveal ? <Money sats={reveal.feeSats} /> : '—'}</dd>
            </div>
          </dl>
          {result.status !== 'fit' ? <Alert tone="warn" title="Outside the tier range">{STATUS_COPY[result.status]}</Alert> : null}
        </div>
      ) : null}

      <section aria-labelledby="minting-rules-title" className="rules-check">
        <h3 id="minting-rules-title" className="h3">
          Minting Rules
        </h3>
        <ul className="checks" aria-label="Minting rules" data-testid="minting-rules">
          {rules.map((r) => (
            <li key={r.id} className={`checks__item ${r.satisfied ? 'is-pass' : 'is-fail'}`} data-testid={`rule-${r.id}`} data-satisfied={r.satisfied}>
              <span className="checks__icon" aria-hidden="true">
                {r.satisfied ? '✓' : '•'}
              </span>
              <span>
                <span className="checks__label">
                  {r.title}
                  <span className="sr-only">{r.satisfied ? ': satisfied' : ': not yet'}</span>
                </span>{' '}
                <Badge tone={r.how === 'measured' ? 'good' : 'neutral'}>{r.how}</Badge>
                <span className="checks__detail">{r.rule}</span>
                <span className="checks__detail">{r.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {error ? <Alert tone="bad" title="Atelier problem">{error}</Alert> : null}

      {source ? (
        <div className="actions">
          {used ? <Badge tone="good">In use below</Badge> : null}
          <Button disabled={!usable} onClick={use}>
            Use this design
          </Button>
        </div>
      ) : null}
    </div>
  );
}

