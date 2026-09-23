import { useMint } from '../flow/context';
import { clearRecovery } from '../lib/recovery';
import { formatTimestamp, shortHash } from '../lib/format';
import { Button } from './ui';

export function ResumeBanner() {
  const { state, dispatch, store } = useMint();
  const b = state.resumeOffer;
  if (!b) return null;
  return (
    <section className="resume" aria-labelledby="resume-title">
      <div>
        <h2 id="resume-title" className="resume__title">
          Welcome back. You have a mint in progress.
        </h2>
        <p className="muted">
          Order <span className="mono">{b.orderId}</span> · funding tx <span className="mono">{shortHash(b.commitTxid)}</span> · saved{' '}
          {formatTimestamp(b.savedAt)}
        </p>
      </div>
      <div className="row">
        <Button onClick={() => dispatch({ type: 'RESUME', bundle: b })}>Resume tracking</Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (
              typeof window === 'undefined' ||
              window.confirm(
                'Forget this order on this device? Keep a copy of the recovery bundle first: it is your only way to self-rescue.',
              )
            ) {
              clearRecovery(store);
              dispatch({ type: 'DISMISS_RESUME' });
            }
          }}
        >
          Forget it
        </Button>
      </div>
    </section>
  );
}
