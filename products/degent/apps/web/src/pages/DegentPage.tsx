/**
 * `/collection/:n`: one Degent, shareable. Sets the title, description, OpenGraph/Twitter tags and a schema.org
 * JSON-LD block client-side. Link unfurlers do not run JavaScript, so the per-Degent OpenGraph IMAGE needs the
 * edge rendering described in the README ("Share cards"); this page is what that edge function would mirror.
 */
import { useEffect, useState } from 'react';
import { CHARTER_SIZE, type RegisterMember } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { formatSize } from '../lib/format';
import { ExternalLink } from '../components/ui';
import { GoldFrame, SiteLink, useDocumentMeta, type PageMeta } from '../site/components';
import { useMintMode } from '../site/mintMode';
import { DegentDetails, ordinalsUrl } from '../site/DegentDetails';

export function degentMeta(m: RegisterMember, siteUrl: string, ordBase: string): PageMeta {
  const url = `${siteUrl}/collection/${m.n}`;
  const description = `Degent #${m.n} of the Decentralized Gentlemen Club: ${formatSize(m.bytes)} inscribed on Bitcoin${m.height !== null ? ` in block ${m.height}` : ''}.`;
  return {
    title: `Degent #${m.n} · degent.club`,
    description,
    image: m.contentUrl,
    url,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'VisualArtwork',
      name: `Degent #${m.n}`,
      description,
      url,
      image: m.contentUrl,
      identifier: m.id,
      artform: 'Bitcoin ordinal inscription',
      sameAs: ordinalsUrl(ordBase, m.id),
      isPartOf: { '@type': 'CreativeWorkSeries', name: 'Decentralized Gentlemen Club', url: `${siteUrl}/collection` },
    },
  };
}

export function DegentPage({ n }: { n: number }) {
  const { services, app } = useMint();
  const mintReadonly = useMintMode().readonly;
  const [m, setM] = useState<RegisterMember | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    setM(null);
    setMissing(false);
    services.mintApi
      .getRegisterMember(n)
      .then((x) => alive && setM(x))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [services, n]);

  useDocumentMeta(m ? degentMeta(m, app.siteUrl, app.ordContentUrl) : { title: `Degent #${n} · degent.club` });
  const share = `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Degent #${n} of the Decentralized Gentlemen Club ${app.siteUrl}/collection/${n}`)}`;

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <SiteLink to="/collection">The Collection</SiteLink> <span aria-hidden="true">/</span> <span aria-current="page">Degent #{n}</span>
      </nav>
      <div className="degent-page">
        <div>{m ? <GoldFrame src={m.contentUrl} alt={`Degent #${n}`} size="lg" /> : <div className="goldframe goldframe--lg goldframe--empty" aria-hidden="true" />}</div>
        <div>
          <h1 tabIndex={-1}>Degent #{n}</h1>
          {missing ? (
            <p>
              No Degent #{n} in the Register yet. The club counts {CHARTER_SIZE.toLocaleString('en-US')}; {mintReadonly ? <>minting opens soon</> : <SiteLink to="/mint">mint one</SiteLink>}.
            </p>
          ) : m ? (
            <>
              <DegentDetails member={m} />
              <p className="small">
                <ExternalLink href={share}>Share on X</ExternalLink>
              </p>
            </>
          ) : (
            <p className="muted" role="status">
              Reading the Register…
            </p>
          )}
          <nav className="row" aria-label="Neighbours">
            {n > 1 ? <SiteLink to={`/collection/${n - 1}`}>‹ Degent #{n - 1}</SiteLink> : null}
            {n < CHARTER_SIZE ? <SiteLink to={`/collection/${n + 1}`}>Degent #{n + 1} ›</SiteLink> : null}
          </nav>
        </div>
      </div>
    </div>
  );
}
