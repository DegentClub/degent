import { useEffect, useId, useState } from 'react';
import { readImageInfo, sniffContentType, tierForSize, DEGENT_RULES_CONFIG, TIER_LABELS } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { useStudio } from '../flow/studio';
import { Link } from '../components/Link';
import { RulesPills } from '../components/RulesPills';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, Fact, Mono, Panel, errorText, useObjectUrl } from '../components/ui';
import { CheckList } from './Validate';
import { StatusPill } from './Studio';
import { CapField, parseCap } from './StudioExtras';
import { formatBytesExact } from '../lib/format';
import type { StudioArtwork } from '../services/studioApi';

interface Picked {
  name: string;
  bytes: Uint8Array;
  contentType: string;
  width: number | null;
  height: number | null;
  sha256: string;
}

type Phase = 'idle' | 'declaring' | 'uploading' | 'done';

export function StudioUpload() {
  const { services, app } = useMint();
  const { session } = useStudio();
  const ids = { title: useId(), desc: useId(), file: useId() };
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [cap, setCap] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StudioArtwork | null>(null);
  const previewUrl = useObjectUrl(picked?.bytes ?? null, picked?.contentType ?? 'application/octet-stream');

  const onFile = async (file: File | undefined) => {
    setError(null);
    setResult(null);
    if (!file) return setPicked(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = readImageInfo(bytes);
      const contentType = info?.contentType ?? sniffContentType(bytes) ?? file.type;
      setPicked({ name: file.name, bytes, contentType, width: info?.width ?? null, height: info?.height ?? null, sha256: services.inscription.sha256Hex(bytes) });
    } catch (e) {
      setError(`Could not read that file: ${errorText(e)}`);
    }
  };

  const tier = picked ? tierForSize(picked.bytes.length, DEGENT_RULES_CONFIG) : null;
  const square = picked ? picked.width !== null && picked.width === picked.height : false;
  const checks = picked
    ? [
        { id: 'format', label: 'Accepted image format', passed: DEGENT_RULES_CONFIG.allowedContentTypes.includes(picked.contentType), detail: picked.contentType },
        { id: 'size', label: 'Size fits a tier', passed: tier !== null, detail: `${formatBytesExact(picked.bytes.length)}${tier ? ` · ${TIER_LABELS[tier.tier]}` : ''}` },
        { id: 'square', label: 'Square', passed: square, detail: picked.width && picked.height ? `${picked.width}×${picked.height}px` : 'dimensions unreadable' },
      ]
    : [];
  const localOk = checks.length > 0 && checks.every((c) => c.passed);
  const capParsed = parseCap(cap);
  const canSubmit = !!session && !!picked && localOk && title.trim().length > 0 && title.length <= 80 && desc.length <= 500 && capParsed !== undefined && phase === 'idle';

  const submit = async () => {
    if (!session || !picked || capParsed === undefined) return;
    setError(null);
    try {
      setPhase('declaring');
      const created = await services.studio.createArtwork(session.token, {
        title: title.trim(),
        ...(desc.trim() ? { description: desc.trim() } : {}),
        contentType: picked.contentType,
        contentLength: picked.bytes.length,
        ...(capParsed !== null ? { maxEditions: capParsed } : {}),
      });
      setPhase('uploading');
      const reviewed = await services.studio.uploadContent(created.artwork.id, created.uploadToken, picked.bytes);
      setResult(reviewed);
      setPhase('done');
    } catch (e) {
      setError(errorText(e));
      setPhase('idle');
    }
  };

  // Waiting for the house: poll until the verdict lands (bounded).
  const waiting = result?.status === 'reviewing';
  useEffect(() => {
    if (!waiting || !result || !session) return;
    let alive = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const w = await services.studio.getArtwork(result.id, session.token);
        if (!alive) return;
        setResult(w);
        if (w.status !== 'reviewing') return;
      } catch {
        /* keep polling */
      }
      if (++polls < 120 && alive) timer = setTimeout(() => void tick(), app.pollIntervalMs);
    };
    timer = setTimeout(() => void tick(), app.pollIntervalMs);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [waiting, result?.id, session, services, app.pollIntervalMs]);

  const reasons = result ? [...(result.review?.house?.reasons ?? []), ...(result.review?.automated?.reasons ?? [])] : [];

  return (
    <div className="screen screen--studio">
      <p className="crumbs">
        <Link to={{ name: 'studio' }}>← Studio</Link>
      </p>
      <ScreenHeading
        step="Artist Studio"
        title="Hang a Degent."
        lede="Declare the piece, upload the exact bytes, and the house reviews it once: the rules on the bytes, then a look at the picture. A skipped check never approves — it waits for the house."
      />
      {!session ? (
        <Alert tone="warn" title="Sign in first">
          <Link to={{ name: 'studio' }}>Sign in with Bitcoin</Link> in the studio to hang a piece.
        </Alert>
      ) : null}

      <Panel kicker="House rules" title="What passes">
        <RulesPills />
      </Panel>

      <Panel title="The piece">
        <div className="field">
          <label htmlFor={ids.title} className="label">
            Title <span className="muted small">({title.length}/80)</span>
          </label>
          <input id={ids.title} type="text" maxLength={80} value={title} onChange={(e) => setTitle(e.currentTarget.value)} disabled={phase !== 'idle'} />
        </div>
        <div className="field">
          <label htmlFor={ids.desc} className="label">
            Description <span className="muted small">(optional, {desc.length}/500)</span>
          </label>
          <textarea id={ids.desc} maxLength={500} rows={3} value={desc} onChange={(e) => setDesc(e.currentTarget.value)} disabled={phase !== 'idle'} />
        </div>
        <CapField value={cap} onChange={setCap} disabled={phase !== 'idle'} />
        <div className="field">
          <label htmlFor={ids.file} className="label">
            Image (JPEG recommended; PNG, WebP, AVIF, GIF accepted)
          </label>
          <input
            id={ids.file}
            type="file"
            accept={DEGENT_RULES_CONFIG.allowedContentTypes.join(',')}
            onChange={(e) => void onFile(e.currentTarget.files?.[0])}
            disabled={phase !== 'idle'}
            aria-label="Artwork file"
          />
        </div>
        {picked ? (
          <div className="exact">
            <figure className="exact__preview">
              {previewUrl ? <img src={previewUrl} alt="Preview rendered from the exact bytes to be hung" /> : null}
              <figcaption className="small muted">{picked.name}</figcaption>
            </figure>
            <div className="exact__facts">
              <CheckList checks={checks} label="Local checks" />
              <dl className="facts">
                <Fact label="SHA-256 of these bytes">
                  <Mono wrap>{picked.sha256}</Mono>
                </Fact>
              </dl>
            </div>
          </div>
        ) : null}
        {error ? <Alert tone="bad" title="Could not hang the piece">{error}</Alert> : null}
        <div aria-live="polite" className="status-line">
          {phase === 'declaring' ? 'Declaring the piece…' : phase === 'uploading' ? 'Uploading the exact bytes and running the review…' : ''}
        </div>
        {!result ? (
          <div className="actions">
            <Button busy={phase === 'declaring' || phase === 'uploading'} disabled={!canSubmit} onClick={() => void submit()}>
              Submit for review
            </Button>
          </div>
        ) : null}
      </Panel>

      {result ? (
        <Panel title="The verdict" kicker={`Artwork ${result.id}`}>
          <p className="fitline" aria-live="polite" data-testid="verdict">
            <StatusPill artwork={result} />
            {result.status === 'approved' ? (
              <>
                {' '}
                It hangs in the gallery. <Link to={{ name: 'artwork', id: result.id }}>See it</Link>.
              </>
            ) : null}
            {result.status === 'reviewing' && result.needsHuman ? (
              <> The automated review could not decide on its own (a check was skipped), so the house will look. This page keeps checking.</>
            ) : null}
            {result.status === 'rejected' ? <> Not admitted; adjust the art and submit again.</> : null}
          </p>
          {result.review?.automated ? <CheckList checks={result.review.automated.checks} label="Review checks" /> : null}
          {reasons.length > 0 ? (
            <Alert tone="bad" title="Reasons">
              <ul>
                {reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {result.review?.house ? (
            <p className="small muted">
              House decision: <Badge tone={result.review.house.decision === 'approve' ? 'good' : 'bad'}>{result.review.house.decision}</Badge>
            </p>
          ) : null}
          <div className="actions">
            <Link to={{ name: 'studio' }} className="btn btn--secondary">
              Back to the studio
            </Link>
            {result.status === 'rejected' ? (
              <Button
                onClick={() => {
                  setResult(null);
                  setPhase('idle');
                }}
              >
                Try again
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
