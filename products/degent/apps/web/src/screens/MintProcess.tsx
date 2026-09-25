/**
 * `#/mint-process` (the live site's /mint/ "Minting Rules"): four check-marked cards built from
 * `DEGENT_RULES` in the mint SDK (the rules the studio and the mint enforce), the "Did you know?"
 * callout, and a stats row from the certificate.
 */
import { DEGENT_RULES, type DegentRule } from '@bsh/degent-mint-sdk';
import { useSite } from '../flow/site';
import { Icon } from '../components/Icons';
import { Link } from '../components/Link';
import { Tag } from '../components/Meters';
import { PageHero } from '../components/Sections';
import { formatMB } from '../lib/counts';
import { groupDigits } from '../lib/format';
import { COPY } from '../lib/site';

const CHECK_LABEL = { automated: 'checked by code', vision: 'checked by eye', both: 'code + eye' } as const;

export interface RuleCard {
  id: string;
  title: string;
  texts: string[];
  checks: Array<DegentRule['check']>;
}

/**
 * The site's four cards from the SDK's five rules: "File format & size" carries the `square` rule too
 * (the live copy reads "Square JPEG format with a minimum size of 200KB").
 */
export function ruleCards(rules: readonly DegentRule[] = DEGENT_RULES): RuleCard[] {
  const square = rules.find((r) => r.id === 'square');
  return rules
    .filter((r) => r.id !== 'square')
    .map((r) =>
      r.id === 'format' && square
        ? { id: r.id, title: r.title, texts: [r.text, square.text], checks: [r.check, square.check] }
        : { id: r.id, title: r.title, texts: [r.text], checks: [r.check] },
    );
}

export function MintProcess() {
  const { certificate, demo } = useSite();
  const c = certificate.status === 'ready' ? certificate.counts : null;
  const cards = ruleCards();
  return (
    <div className="screen screen--site screen--process">
      <PageHero pill="Mint Process" title={COPY.rulesTitle} sub={COPY.rulesLede} wall={false} />
      {c ? (
        <dl className="statrow" aria-label="Collection so far">
          <div>
            <dt>Minted</dt>
            <dd>
              <span className="mono">{groupDigits(c.minted)}</span> <Tag kind={demo ? 'demo' : 'certified'} />
            </dd>
          </div>
          <div>
            <dt>Blockspace</dt>
            <dd>
              <span className="mono">{formatMB(c.bytes)}</span> <Tag kind={demo ? 'demo' : 'certified'} />
            </dd>
          </div>
          {c.studio ? (
            <div>
              <dt>Studio artists</dt>
              <dd>
                <span className="mono">{c.studio.artists}</span>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <ul className="rulecards" aria-label="Minting rules">
        {cards.map((r) => (
          <li key={r.id} className="rulecard" data-testid={`rulecard-${r.id}`}>
            <span className="rulecard__check" aria-hidden="true">
              <Icon.Check />
            </span>
            <div>
              <h2 className="rulecard__title">{r.title}</h2>
              {r.texts.map((t) => (
                <p key={t} className="rulecard__text">
                  {t}
                </p>
              ))}
              <p className="rulecard__how">{[...new Set(r.checks)].map((k) => CHECK_LABEL[k]).join(' · ')}</p>
            </div>
          </li>
        ))}
      </ul>
      <aside className="callout" aria-labelledby="dyk">
        <h2 id="dyk" className="callout__title">
          Did you know?
        </h2>
        <p>{COPY.didYouKnow}</p>
      </aside>
      <div className="row">
        <Link to={{ name: 'mint', artworkId: null }} className="btn btn--primary">
          <Icon.Rocket /> Mint Now!
        </Link>
        <Link to={{ name: 'studio' }} className="btn btn--dark">
          Hang your own in the Studio
        </Link>
      </div>
    </div>
  );
}
