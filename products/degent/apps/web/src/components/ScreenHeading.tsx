import type { ReactNode } from 'react';

/** Each screen's h1 is focusable so the app can move focus to it on step change. */
export function ScreenHeading({ step, title, lede }: { step: string; title: ReactNode; lede?: ReactNode }) {
  return (
    <div className="screen-heading">
      <p className="kicker">{step}</p>
      <h1 tabIndex={-1}>{title}</h1>
      {lede ? <p className="lede">{lede}</p> : null}
    </div>
  );
}
