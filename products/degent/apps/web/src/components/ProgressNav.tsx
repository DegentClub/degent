import { useMint } from '../flow/context';
import { canEnter } from '../flow/reducer';
import { STEP_LABELS, STEPS } from '../flow/state';

export function ProgressNav() {
  const { state, dispatch } = useMint();
  const current = STEPS.indexOf(state.step);
  const locked = state.step === 'track' || (state.step === 'pay' && state.pay.phase !== 'idle' && state.pay.phase !== 'error');
  return (
    <nav className="progress" aria-label="Mint progress">
      <ol>
        {STEPS.map((step, i) => {
          const status = i < current ? 'done' : i === current ? 'current' : 'upcoming';
          const clickable = !locked && i < current && canEnter(state, step);
          return (
            <li key={step} className={`progress__item progress__item--${status}`}>
              {clickable ? (
                <button type="button" className="progress__btn" onClick={() => dispatch({ type: 'GO', step })}>
                  <span className="progress__num" aria-hidden="true">{i + 1}</span>
                  <span className="progress__label">{STEP_LABELS[step]}</span>
                  <span className="sr-only"> (completed, go back)</span>
                </button>
              ) : (
                <span className="progress__btn" aria-current={status === 'current' ? 'step' : undefined}>
                  <span className="progress__num" aria-hidden="true">{i + 1}</span>
                  <span className="progress__label">{STEP_LABELS[step]}</span>
                  {status === 'done' ? <span className="sr-only"> (completed)</span> : null}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
