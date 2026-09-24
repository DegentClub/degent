import { useEffect, useState } from 'react';
import { useMint } from '../flow/context';
import { useStudio } from '../flow/studio';
import { Link } from '../components/Link';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, ExternalLink, Fact, Money, Mono, Panel, errorText } from '../components/ui';
import { formatTimestamp, shortHash } from '../lib/format';
import type { RoyaltiesResponse } from '../services/studioApi';

export function StudioRoyalties() {
  const { services, app } = useMint();
  const { session } = useStudio();
  const [data, setData] = useState<RoyaltiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    services.studio
      .getMyRoyalties(session.token, 1, 100)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [services, session]);

  return (
    <div className="screen screen--studio">
      <p className="crumbs">
        <Link to={{ name: 'studio' }}>← Studio</Link>
      </p>
      <ScreenHeading
        step="Artist Studio"
        title="What the club paid you."
        lede="Every mint of one of your Degents pays your royalty as output [1] of the minter’s funding transaction. The studio keeps a ledger of what the mint told it; the chain is the truth."
      />
      {!session ? (
        <Alert tone="warn" title="Sign in first">
          <Link to={{ name: 'studio' }}>Sign in with Bitcoin</Link> to see your royalties.
        </Alert>
      ) : null}
      {error ? <Alert tone="bad" title="Could not load royalties">{error}</Alert> : null}
      {session && !data && !error ? <p className="muted" role="status">Fetching the ledger…</p> : null}
      {data ? (
        <>
          <Panel title="Totals">
            <dl className="facts facts--inline">
              <Fact label="Mints">
                <span className="mono" data-testid="royalty-records">{data.totals.records}</span>
              </Fact>
              <Fact label="Royalties">
                <span data-testid="royalty-total">
                  <Money sats={data.totals.royaltySats} strong />
                </span>
              </Fact>
            </dl>
          </Panel>
          <Panel title="Records" kicker="Newest first">
            {data.items.length === 0 ? <p className="muted">No mints yet.</p> : null}
            {data.items.length > 0 ? (
              <table className="bill royalties">
                <caption className="sr-only">Royalty records</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Artwork</th>
                    <th scope="col">Minter</th>
                    <th scope="col">Funding output</th>
                    <th scope="col">Royalty</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.orderId} data-testid={`royalty-${r.orderId}`}>
                      <td className="mono" data-label="When">{formatTimestamp(r.at)}</td>
                      <td data-label="Artwork">
                        <Link to={{ name: 'artwork', id: r.artworkId }}>
                          <Mono>{r.artworkId}</Mono>
                        </Link>
                      </td>
                      <td className="mono" data-label="Minter">{r.minterAddress ? shortHash(r.minterAddress, 6) : '—'}</td>
                      <td data-label="Funding output">
                        <ExternalLink href={`${app.explorerUrl}/tx/${r.fundingTxid}`}>
                          {shortHash(r.fundingTxid, 6)}:{r.vout}
                        </ExternalLink>
                      </td>
                      <td data-label="Royalty">
                        <Money sats={r.royaltySats} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
