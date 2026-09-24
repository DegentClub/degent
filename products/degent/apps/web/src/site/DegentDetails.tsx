/**
 * On-chain facts for one Degent: the Register's own fields (id, owner, size, block) render at once; ord's
 * (content type, fee, timestamp) come from the prefetch cache, so opening a Degent never flashes "LOADING…".
 */
import type { RegisterMember } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { formatSats, formatTimestamp, groupDigits } from '../lib/format';
import { Mono } from '../components/ui';
import { useInscriptionInfo } from './data';
import { ExternalButton } from './components';

export function ordinalsUrl(ordBase: string, id: string): string {
  return `${ordBase}/inscription/${encodeURIComponent(id)}`;
}

export function buyItemUrl(template: string, id: string): string {
  return template.replace('{id}', encodeURIComponent(id));
}

function Pending() {
  // Not "LOADING…": a quiet placeholder, announced as busy for assistive tech.
  return <span className="skeleton" aria-busy="true" aria-label="fetching from ord" />;
}

export function DegentDetails({ member }: { member: RegisterMember }) {
  const { app } = useMint();
  const info = useInscriptionInfo(member.id);
  const ok = info?.status === 'ok' ? info.info : null;
  const failed = info?.status === 'error';
  const ord = (v: string | null | undefined) => (ok ? (v ?? '—') : failed ? '—' : <Pending />);
  return (
    <>
      <dl className="facts details">
        <div className="fact">
          <dt>Inscription ID</dt>
          <dd>
            <Mono wrap>{member.id}</Mono>
          </dd>
        </div>
        <div className="fact">
          <dt>Address</dt>
          <dd>{member.owner ? <Mono wrap>{member.owner}</Mono> : <span className="muted">unknown</span>}</dd>
        </div>
        <div className="fact">
          <dt>Content type</dt>
          <dd className="mono">{ord(ok?.contentType)}</dd>
        </div>
        <div className="fact">
          <dt>Content length</dt>
          <dd className="mono">{groupDigits(ok?.contentLength ?? member.bytes)} bytes</dd>
        </div>
        <div className="fact">
          <dt>Timestamp</dt>
          <dd className="mono">{ord(ok?.timestamp ? formatTimestamp(ok.timestamp) : null)}</dd>
        </div>
        <div className="fact">
          <dt>Block height</dt>
          <dd className="mono">{member.height !== null ? groupDigits(member.height) : ord(ok?.height != null ? groupDigits(ok.height) : null)}</dd>
        </div>
        <div className="fact">
          <dt>Fee</dt>
          <dd className="mono">{ord(ok?.fee != null ? formatSats(ok.fee) : null)}</dd>
        </div>
        <div className="fact">
          <dt>Membership</dt>
          <dd className="small">{member.via === 'gallery' ? 'Gallery member (inscribed before the parent)' : 'Child of the club parent'} · the Register</dd>
        </div>
      </dl>
      {failed ? <p className="small muted">ord did not answer; the Register’s facts are shown.</p> : null}
      <div className="row">
        <ExternalButton href={ordinalsUrl(app.ordContentUrl, member.id)} variant="primary">
          View on Ordinals.com
        </ExternalButton>
        <ExternalButton href={buyItemUrl(app.buyItemUrl, member.id)}>Buy Item</ExternalButton>
      </div>
    </>
  );
}
