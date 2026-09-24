import { useId, useState, type FormEvent } from 'react';
import { useSite } from '../context';
import { validateNewsletter } from '../services/real/newsletter';

type Phase = { k: 'idle' } | { k: 'sending' } | { k: 'done'; already: boolean } | { k: 'error'; message: string };

/** Newsletter sign-up (name + e-mail) → NewsletterService. Honest states; no mailto fallback. */
export function Newsletter() {
  const { site } = useSite();
  const nl = site.newsletter;
  const ids = { name: useId(), email: useId(), status: useId() };
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const invalid = validateNewsletter({ name, email });
    if (invalid) {
      setPhase({ k: 'error', message: invalid });
      return;
    }
    setPhase({ k: 'sending' });
    try {
      const r = await nl.subscribe({ name, email });
      setPhase(r.ok ? { k: 'done', already: r.alreadySubscribed } : { k: 'error', message: r.message });
    } catch {
      setPhase({ k: 'error', message: 'Something went wrong. Please try again later.' });
    }
  };

  if (phase.k === 'done') {
    return (
      <div className="newsletter" data-testid="newsletter">
        <p className="newsletter__ok" role="status">
          {phase.already ? 'You are already on the list. Thank you!' : 'Thank you! Check your inbox to confirm your subscription.'}
        </p>
      </div>
    );
  }

  return (
    <form className="newsletter" onSubmit={(e) => void submit(e)} noValidate aria-describedby={ids.status} data-testid="newsletter">
      <p className="newsletter__lede">Stay updated with our latest news and drops.</p>
      {!nl.configured ? (
        <p className="newsletter__na" id={ids.status}>
          Newsletter sign-up is not available on this site yet.
        </p>
      ) : null}
      <div className="newsletter__fields">
        <label className="field-s" htmlFor={ids.name}>
          <span className="field-s__label">Name</span>
          <input id={ids.name} name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} disabled={!nl.configured || phase.k === 'sending'} />
        </label>
        <label className="field-s" htmlFor={ids.email}>
          <span className="field-s__label">E-mail</span>
          <input
            id={ids.email}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!nl.configured || phase.k === 'sending'}
            aria-invalid={phase.k === 'error' ? true : undefined}
          />
        </label>
        <button type="submit" className="cta cta--gradient cta--sm" disabled={!nl.configured || phase.k === 'sending'}>
          <span>{phase.k === 'sending' ? 'Subscribing…' : 'Subscribe'}</span>
        </button>
      </div>
      <p className="newsletter__status" id={nl.configured ? ids.status : undefined} aria-live="polite">
        {phase.k === 'error' ? <span className="newsletter__err">{phase.message}</span> : null}
      </p>
    </form>
  );
}
