import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { readImageInfo, sniffContentType, tierForSize, TIER_LABELS, type Tier } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { laneForArtwork } from '../flow/effects';
import type { Artwork } from '../flow/state';
import { Frame } from '../components/Frame';
import { Link } from '../components/Link';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, Fact, Mono, Panel, errorText, useObjectUrl } from '../components/ui';
import { ART_BRIEF, tierRule } from '../lib/rules';
import { capScale, classifySize, fitToRange, scaleLadder, type FitResult } from '../lib/compression';
import { formatBytesExact, formatSize, groupDigits, shortHash } from '../lib/format';
import type { EncodeType, SourceImage } from '../services/types';
import type { StudioArtwork } from '../services/studioApi';

/** Step 3: a studio Degent chosen in the gallery skips the upload/compression tools (ADR-0007). */
export function Create() {
  const { state } = useMint();
  return state.studioArtwork ? <CreateStudio studioArtwork={state.studioArtwork} /> : <CreateUpload />;
}

/**
 * The exact bytes come from the studio's immutable content endpoint; their SHA-256 must match the
 * artwork record before anything else happens. Tier follows from the size; no brief to tick — the
 * studio reviewed the piece when the artist hung it.
 */
function CreateStudio({ studioArtwork }: { studioArtwork: StudioArtwork }) {
  const { state, dispatch, services, app } = useMint();
  const config = state.config!;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const art = state.artwork && state.artwork.sha256 === studioArtwork.contentSha256 ? state.artwork : null;

  useEffect(() => {
    if (art) return;
    let alive = true;
    setBusy(true);
    setError(null);
    services.studio
      .getContent(studioArtwork.id)
      .then((c) => {
        if (!alive) return;
        const sha256 = services.inscription.sha256Hex(c.bytes);
        if (studioArtwork.contentSha256 && sha256 !== studioArtwork.contentSha256) {
          throw new Error(`The bytes served for this artwork hash to ${shortHash(sha256)}, not the ${shortHash(studioArtwork.contentSha256)} on record. Refusing to mint them.`);
        }
        const info = readImageInfo(c.bytes);
        const tier = tierForSize(c.bytes.length, config);
        if (!tier) throw new Error(`${formatBytesExact(c.bytes.length)} does not fit any tier of this collection.`);
        const artwork: Artwork = {
          fileName: `${studioArtwork.title}.${(info?.contentType ?? c.contentType).replace('image/', '')}`,
          bytes: c.bytes,
          contentType: info?.contentType ?? sniffContentType(c.bytes) ?? c.contentType,
          size: c.bytes.length,
          width: info?.width ?? 0,
          height: info?.height ?? 0,
          sha256,
          origin: 'original',
        };
        dispatch({ type: 'TIER_SELECTED', tier: tier.tier });
        dispatch({ type: 'ARTWORK_READY', artwork });
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [art, studioArtwork, services, config, dispatch]);

  const previewUrl = useObjectUrl(art?.bytes ?? null, art?.contentType ?? 'application/octet-stream');
  const rule = tierRule(config, state.tier);
  const laneInfo =
    art && state.wallet ? laneForArtwork(services, { artwork: art, recipientAddress: state.wallet.ordinals.address, config, network: app.network }) : null;
  const laneSurprise = laneInfo !== null && laneInfo.lane !== null && laneInfo.lane !== rule.lane;

  return (
    <div className="screen">
      <ScreenHeading
        step="Step 3 of 7"
        title="Mint this Degent."
        lede="A studio piece: the artist hung it, the house reviewed it, and the exact bytes come from the gallery. Nothing to upload or compress."
      />
      <Panel title={studioArtwork.title} kicker={`By ${shortHash(studioArtwork.artist, 6)}${studioArtwork.featured ? ' · featured' : ''}`}>
        <div className="exact">
          <Frame size="large" src={previewUrl ?? services.studio.contentUrl(studioArtwork.id)} alt={`${studioArtwork.title}: the exact bytes to be inscribed`} />
          <div className="exact__facts">
            {studioArtwork.description ? <p>{studioArtwork.description}</p> : null}
            <div aria-live="polite" className="small muted">
              {busy ? 'Fetching the exact bytes from the studio…' : ''}
            </div>
            {error ? <Alert tone="bad" title="Could not fetch the artwork">{error}</Alert> : null}
            {art ? (
              <dl className="facts">
                <Fact label="Tier">
                  <Badge tone="brass">{TIER_LABELS[state.tier]}</Badge> <span className="muted small">by size</span>
                </Fact>
                <Fact label="Bytes">
                  <Mono>{formatBytesExact(art.size)}</Mono> <span className="muted">({formatSize(art.size)})</span>
                </Fact>
                <Fact label="Dimensions">
                  <Mono>
                    {art.width} × {art.height}px
                  </Mono>
                </Fact>
                <Fact label="Content type">
                  <Mono>{art.contentType}</Mono>
                </Fact>
                <Fact label="SHA-256 (matches the studio record)">
                  <Mono wrap>{art.sha256}</Mono>
                </Fact>
                {laneInfo ? (
                  <Fact label="Reveal weight → lane">
                    <span data-testid="artwork-lane">
                      <Mono>{groupDigits(laneInfo.weight)} WU</Mono>{' '}
                      {laneInfo.lane ? <Badge tone={laneInfo.lane === 'block' ? 'brass' : 'neutral'}>{laneInfo.lane} lane</Badge> : <Badge tone="bad">too heavy</Badge>}
                    </span>
                  </Fact>
                ) : null}
              </dl>
            ) : null}
            {laneSurprise && laneInfo?.lane === 'block' ? (
              <Alert tone="warn" title={`This ${rule.label} travels the block lane`}>
                Its reveal weighs {groupDigits(laneInfo.weight)} WU, over the 400,000 WU standard relay limit, so it queues for a block slot.
              </Alert>
            ) : null}
          </div>
        </div>
        <p className="small muted">
          Changed your mind? <Link to={{ name: 'gallery', page: 1, artist: null }}>Pick another Degent</Link> or{' '}
          <button type="button" className="linkbtn" onClick={() => dispatch({ type: 'STUDIO_ARTWORK_CLEARED' })}>
            mint your own art instead
          </button>
          .
        </p>
      </Panel>
      <div className="actions">
        <Button variant="ghost" onClick={() => dispatch({ type: 'BACK' })}>
          Back
        </Button>
        <Button disabled={!art || busy} onClick={() => dispatch({ type: 'GO', step: 'validate' })}>
          Continue to Validate
        </Button>
      </div>
    </div>
  );
}

interface Loaded {
  name: string;
  bytes: Uint8Array;
  declaredType: string;
  source: SourceImage;
}

type Mode = 'original' | 'reencode';

const SCALE_OPTIONS = [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.3];

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

function CreateUpload() {
  const { state, dispatch, services, app } = useMint();
  const config = state.config!;
  const rule = tierRule(config, state.tier);
  const range = { min: rule.minBytes, max: rule.maxBytes };

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<Mode>('reencode');
  const [type, setType] = useState<EncodeType>('image/webp');
  const [quality, setQuality] = useState(0.8);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState<'loading' | 'encoding' | 'fitting' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState<FitResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);
  const ids = { file: useId(), quality: useId(), scale: useId(), format: useId() };

  // `scale` is a step relative to the largest size the collection allows (maxDimensionPx cap).
  const maxScale = loaded ? capScale(loaded.source.width, loaded.source.height, config.maxDimensionPx) : 1;
  const effScale = scale * maxScale;

  // ------------------------------------------------ produce the exact bytes
  const produce = useCallback(async () => {
    if (!loaded) return;
    const my = ++reqId.current;
    setBusy('encoding');
    setError(null);
    try {
      let bytes: Uint8Array;
      let width: number;
      let height: number;
      let contentType: string;
      if (mode === 'original') {
        bytes = loaded.bytes;
        const info = readImageInfo(bytes);
        contentType = info?.contentType ?? sniffContentType(bytes) ?? loaded.declaredType;
        width = info?.width ?? loaded.source.width;
        height = info?.height ?? loaded.source.height;
      } else {
        const enc = await services.images.encode(loaded.source, { type, quality, scale: effScale });
        bytes = await blobBytes(enc.blob);
        contentType = sniffContentType(bytes) ?? enc.blob.type ?? type;
        width = enc.width;
        height = enc.height;
      }
      if (my !== reqId.current) return;
      const artwork: Artwork = {
        fileName: loaded.name,
        bytes,
        contentType,
        size: bytes.length,
        width,
        height,
        sha256: services.inscription.sha256Hex(bytes),
        origin: mode === 'original' ? 'original' : 'reencoded',
        ...(mode === 'reencode' ? { quality, scale: effScale } : {}),
      };
      dispatch({ type: 'ARTWORK_READY', artwork });
    } catch (e) {
      if (my === reqId.current) setError(errorText(e));
    } finally {
      if (my === reqId.current) setBusy(null);
    }
  }, [loaded, mode, type, quality, effScale, services, dispatch]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => void produce(), mode === 'reencode' ? 150 : 0);
    return () => clearTimeout(t);
  }, [produce, loaded, mode]);

  // ------------------------------------------------ auto-fit to the tier range
  const autoFit = useCallback(
    async (src: Loaded, fitType: EncodeType) => {
      setBusy('fitting');
      setFit(null);
      try {
        const cap = capScale(src.source.width, src.source.height, config.maxDimensionPx);
        const ladder = scaleLadder(src.source.width, src.source.height, config.minDimensionPx, SCALE_OPTIONS.map((s) => s * cap));
        const result = await fitToRange(
          async (q, s) => {
            const enc = await services.images.encode(src.source, { type: fitType, quality: q, scale: s });
            return { size: enc.blob.size };
          },
          range,
          { scales: ladder, maxQuality: 0.95 },
        );
        setFit(result);
        setMode('reencode');
        setQuality(result.best.quality);
        setScale(Math.round((result.best.scale / cap) * 100) / 100);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [services, config, range.min, range.max],
  );

  // ------------------------------------------------ load a file
  const load = async (file: Blob, name: string) => {
    setBusy('loading');
    setError(null);
    setFit(null);
    dispatch({ type: 'ARTWORK_CLEARED' });
    try {
      const bytes = await blobBytes(file);
      const source = await services.images.decode(file);
      const next: Loaded = { name, bytes, declaredType: file.type, source };
      setLoaded(next);
      setScale(1);
      const sniffed = sniffContentType(bytes);
      const fitsAsIs =
        sniffed !== null &&
        config.allowedContentTypes.includes(sniffed) &&
        classifySize(bytes.length, range) === 'within' &&
        Math.max(source.width, source.height) <= config.maxDimensionPx;
      if (fitsAsIs) {
        setMode('original');
        setBusy(null);
      } else {
        setMode('reencode');
        await autoFit(next, type);
      }
    } catch (e) {
      setError(`Could not read that image: ${errorText(e)}`);
      setBusy(null);
    }
  };

  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void load(f, f.name);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    onFiles(e.dataTransfer.files);
  };

  const art = state.artwork;
  const previewUrl = useObjectUrl(art?.bytes ?? null, art?.contentType ?? 'application/octet-stream');
  const sizeFit = art ? classifySize(art.size, range) : null;
  // ADR-0005 §3: the lane is decided by the exact reveal weight, not by the tier. Say so here, before the quote.
  const laneInfo =
    art && state.wallet && sizeFit === 'within'
      ? laneForArtwork(services, { artwork: art, recipientAddress: state.wallet.ordinals.address, config, network: app.network })
      : null;
  const laneSurprise = laneInfo !== null && laneInfo.lane !== null && laneInfo.lane !== rule.lane;
  const briefDone = ART_BRIEF.every((b) => state.briefAck[b.id]);
  const canContinue = !!art && sizeFit === 'within' && briefDone && busy === null;

  const setTier = (tier: Tier) => {
    dispatch({ type: 'TIER_SELECTED', tier });
    setFit(null);
  };

  // Re-fit automatically when the tier changes and we are re-encoding.
  const lastTier = useRef(state.tier);
  useEffect(() => {
    if (lastTier.current !== state.tier && loaded && mode === 'reencode') void autoFit(loaded, type);
    lastTier.current = state.tier;
  }, [state.tier, loaded, mode, type, autoFit]);

  const meterPct = art ? Math.min(100, (art.size / (range.max * 1.25)) * 100) : 0;

  return (
    <div className="screen">
      <ScreenHeading
        step="Step 3 of 7"
        title="Dress the gentleman."
        lede="Bring your art, pick a tier and shape the exact bytes. Everything happens in this browser; nothing is uploaded yet."
      />

      <Panel title="Choose a tier" kicker="Tiers are by content bytes; the lane is by weight">
        <div role="radiogroup" aria-label="Tier" className="tier-pick">
          {config.tiers.map((t) => (
            <label key={t.tier} className={`tier-pick__opt ${state.tier === t.tier ? 'is-on' : ''}`} data-testid={`tier-${t.tier}`}>
              <input type="radio" name="tier" value={t.tier} checked={state.tier === t.tier} onChange={() => setTier(t.tier)} />
              <span className="tier-pick__name">{t.label}</span>
              <span className="mono small">
                {formatSize(t.minBytes)} – {formatSize(t.maxBytes)}
              </span>
              <span className="small muted">{t.description}</span>
              <span className="small">
                <Badge tone={t.lane === 'block' ? 'brass' : 'neutral'}>{t.lane === 'block' ? 'block lane' : 'standard lane'}</Badge>{' '}
                <span className="muted">{t.sharesBlock ? (t.lane === 'block' ? 'shares a block' : 'many per block') : 'a block to itself'}</span>
              </span>
            </label>
          ))}
        </div>
        {state.tier === 'large' ? (
          <Alert tone="warn" title="Large Degents ride the block lane">
            Non-standard relay, so you join the block-lane queue. Your reveal shares a block with other Large Degents when the
            weights fit the 3,990,000 WU budget, otherwise it waits for the next slot. Fees scale with size; you will see the
            exact figure before paying.
          </Alert>
        ) : null}
        {state.tier === 'fullblock' ? (
          <Alert tone="warn" title="Full Block Degents are serious business">
            Your reveal takes a whole block by itself — never shared — so you wait for a block slot of your own. A 3.9 MB Degent
            occupies ~975,000 vB: at 2 sat/vB that is about 0.02 BTC in network fees. You will see the exact figure before paying.
          </Alert>
        ) : null}
      </Panel>

      <div className="create-grid">
        <Panel title="The brief" kicker="House rules">
          <fieldset className="brief">
            <legend className="sr-only">Confirm the art brief</legend>
            {ART_BRIEF.map((b) => (
              <label key={b.id} className="check">
                <input
                  type="checkbox"
                  checked={!!state.briefAck[b.id]}
                  onChange={(e) => dispatch({ type: 'BRIEF_TOGGLED', id: b.id, checked: e.currentTarget.checked })}
                />
                <span>
                  <span className="check__label">{b.label}</span>
                  <span className="check__hint">{b.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="small muted">
            Tip: any AI image generator will do — describe “Pepe the frog in a tuxedo with a bowtie, the word DEGENT”. The
            automated review checks the brief before you can pay.
          </p>
        </Panel>

        <Panel title="Your art">
          <div
            className={`dropzone ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <p>Drag an image here, or</p>
            <label htmlFor={ids.file} className="btn btn--secondary">
              Choose a file
            </label>
            <input
              id={ids.file}
              ref={fileInput}
              className="sr-only"
              type="file"
              accept={config.allowedContentTypes.join(',')}
              onChange={(e) => onFiles(e.currentTarget.files)}
              aria-label="Upload artwork"
            />
            <p className="small muted">{config.allowedContentTypes.map((t) => t.replace('image/', '').toUpperCase()).join(' · ')}</p>
            {services.mode === 'demo' && services.images.sample ? (
              <Button
                variant="ghost"
                onClick={async () => {
                  const b = await services.images.sample!();
                  await load(b, 'demo-gentleman.png');
                }}
              >
                Use a sample gentleman (demo)
              </Button>
            ) : null}
          </div>
          <div aria-live="polite" className="small muted">
            {busy === 'loading' ? 'Reading your image…' : busy === 'fitting' ? 'Finding the best quality that fits the tier…' : busy === 'encoding' ? 'Encoding…' : ''}
          </div>
          {error ? <Alert tone="bad" title="Image problem">{error}</Alert> : null}
        </Panel>
      </div>

      {loaded ? (
        <Panel title="Compression toolkit" kicker={`Target: ${formatSize(range.min)} – ${formatSize(range.max)}`}>
          <div className="toolkit">
            <div role="radiogroup" aria-label="Bytes to inscribe" className="seg">
              <label className={mode === 'original' ? 'is-on' : ''}>
                <input type="radio" name="mode" checked={mode === 'original'} onChange={() => setMode('original')} />
                Original file, untouched
              </label>
              <label className={mode === 'reencode' ? 'is-on' : ''}>
                <input type="radio" name="mode" checked={mode === 'reencode'} onChange={() => setMode('reencode')} />
                Re-encode in browser
              </label>
            </div>
            {mode === 'reencode' ? (
              <div className="toolkit__controls">
                <div className="field">
                  <label htmlFor={ids.format} className="label">
                    Format
                  </label>
                  <select id={ids.format} value={type} onChange={(e) => setType(e.currentTarget.value as EncodeType)}>
                    <option value="image/webp">WebP (best for art)</option>
                    <option value="image/jpeg">JPEG</option>
                  </select>
                </div>
                <div className="field field--grow">
                  <label htmlFor={ids.quality} className="label">
                    Quality <span className="mono">{Math.round(quality * 100)}%</span>
                  </label>
                  <input
                    id={ids.quality}
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={Math.round(quality * 100)}
                    onChange={(e) => setQuality(Number(e.currentTarget.value) / 100)}
                    aria-valuetext={`${Math.round(quality * 100)} percent`}
                  />
                </div>
                <div className="field">
                  <label htmlFor={ids.scale} className="label">
                    Size
                  </label>
                  <select id={ids.scale} value={String(scale)} onChange={(e) => setScale(Number(e.currentTarget.value))}>
                    {SCALE_OPTIONS.map((s) => (
                      <option key={s} value={String(s)}>
                        {Math.round(s * 100)}% · {Math.round(loaded.source.width * s * maxScale)}×
                        {Math.round(loaded.source.height * s * maxScale)}px
                      </option>
                    ))}
                  </select>
                </div>
                <Button variant="secondary" busy={busy === 'fitting'} onClick={() => void autoFit(loaded, type)}>
                  Auto-fit to {rule.label}
                </Button>
              </div>
            ) : null}
            {maxScale < 1 && mode === 'reencode' ? (
              <p className="small muted">Capped at {config.maxDimensionPx}px on the long edge (collection rule).</p>
            ) : null}
            {fit && fit.status !== 'fit' ? (
              <Alert tone="warn" title="Could not land inside the range automatically">
                {fit.status === 'too-small'
                  ? `Even at top quality this image is ${formatBytesExact(fit.best.size)} — below the ${rule.label} minimum. Use a larger or more detailed source, or keep the original file.`
                  : fit.status === 'too-large'
                    ? `Even at the lowest quality and smallest allowed size it is ${formatBytesExact(fit.best.size)}. Try the other tier or a simpler image.`
                    : 'The range is narrower than one quality step for this image. Nudge the quality slider by hand.'}
              </Alert>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {art ? (
        <Panel title="Exactly what will be inscribed">
          <div className="exact">
            <figure className="exact__preview">
              {previewUrl ? <img src={previewUrl} alt="Preview rendered from the exact bytes to be inscribed" /> : null}
              <figcaption className="small muted">Rendered from the final bytes, not your original file.</figcaption>
            </figure>
            <div className="exact__facts">
              <div className={`meter meter--${sizeFit}`} aria-hidden="true">
                <div className="meter__band" style={{ left: `${(range.min / (range.max * 1.25)) * 100}%`, width: `${((range.max - range.min) / (range.max * 1.25)) * 100}%` }} />
                <div className="meter__fill" style={{ width: `${meterPct}%` }} />
              </div>
              <p aria-live="polite" className="fitline">
                {sizeFit === 'within' ? (
                  <Badge tone="good">Fits {rule.label}</Badge>
                ) : sizeFit === 'below' ? (
                  <Badge tone="bad">Too small by {formatBytesExact(range.min - art.size)}</Badge>
                ) : (
                  <Badge tone="bad">Too large by {formatBytesExact(art.size - range.max)}</Badge>
                )}
              </p>
              <dl className="facts">
                <Fact label="Bytes">
                  <Mono>{formatBytesExact(art.size)}</Mono> <span className="muted">({formatSize(art.size)})</span>
                </Fact>
                <Fact label="Dimensions">
                  <Mono>
                    {art.width} × {art.height}px
                  </Mono>
                </Fact>
                <Fact label="Content type">
                  <Mono>{art.contentType}</Mono>
                </Fact>
                <Fact label="SHA-256 of these bytes">
                  <Mono wrap>{art.sha256}</Mono>
                </Fact>
                <Fact label="Source">
                  {art.origin === 'original'
                    ? 'Original file, byte-for-byte'
                    : `Re-encoded at ${Math.round((art.quality ?? 0) * 100)}% quality, ${Math.round((art.scale ?? 1) * 100)}% of the original dimensions`}
                </Fact>
                {laneInfo ? (
                  <Fact label="Reveal weight → lane">
                    <span data-testid="artwork-lane">
                      <Mono>{groupDigits(laneInfo.weight)} WU</Mono>{' '}
                      {laneInfo.lane ? <Badge tone={laneInfo.lane === 'block' ? 'brass' : 'neutral'}>{laneInfo.lane} lane</Badge> : <Badge tone="bad">too heavy</Badge>}
                    </span>
                  </Fact>
                ) : null}
              </dl>
              {laneSurprise && laneInfo?.lane === 'block' ? (
                <Alert tone="warn" title={`This ${rule.label} travels the block lane`}>
                  At {formatBytesExact(art.size)} the reveal weighs {groupDigits(laneInfo.weight)} WU, more than the 400,000 WU a
                  standard transaction may have. It is still a {rule.label} (same tier, same price rules) but it relays through
                  Libre Relay / Slipstream, shares a block by weight and queues for a block slot. Trim a few kB to stay on the
                  standard lane, or continue: the quote will show the lane, position and ETA.
                </Alert>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}

      <div className="actions">
        <Button variant="ghost" onClick={() => dispatch({ type: 'BACK' })}>
          Back
        </Button>
        <Button disabled={!canContinue} onClick={() => dispatch({ type: 'GO', step: 'validate' })}>
          Continue to Validate
        </Button>
      </div>
      {!canContinue && art ? (
        <p className="small muted right" role="status">
          {sizeFit !== 'within' ? 'Get the size inside the tier range to continue. ' : ''}
          {!briefDone ? 'Confirm every point of the brief to continue.' : ''}
        </p>
      ) : null}
    </div>
  );
}
