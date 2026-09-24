/** Inline icons (24x24, currentColor). Decorative: callers label the control. */
import type { ReactNode, SVGProps } from 'react';

function I({ children, ...p }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...p}>
      {children}
    </svg>
  );
}

export const Icon = {
  rocket: () => (
    <I>
      <path d="M5 15c-1.5 1.3-2 4-2 6 2 0 4.7-.5 6-2" />
      <path d="M9 18l-3-3c1.5-5 5.5-10.5 14-12-1.5 8.5-7 12.5-12 14z" />
      <circle cx="15" cy="9" r="1.6" />
    </I>
  ),
  cart: () => (
    <I>
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2 3h3l2.6 12.4a1.5 1.5 0 0 0 1.5 1.1h8.8a1.5 1.5 0 0 0 1.5-1.2L21 8H6.2" />
    </I>
  ),
  menu: () => (
    <I>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </I>
  ),
  close: () => (
    <I>
      <path d="M6 6l12 12M18 6L6 18" />
    </I>
  ),
  home: () => (
    <I>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </I>
  ),
  info: () => (
    <I>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </I>
  ),
  grid: () => (
    <I>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </I>
  ),
  steps: () => (
    <I>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
    </I>
  ),
  scroll: () => (
    <I>
      <path d="M7 3h11a2 2 0 0 1 2 2v2h-4" />
      <path d="M16 7v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1h10" />
      <path d="M7 3a2 2 0 0 0-2 2v13" />
      <path d="M9 8h4M9 12h4" />
    </I>
  ),
  pen: () => (
    <I>
      <path d="M4 20l4-1 11-11-3-3L5 16z" />
      <path d="M14 6l3 3" />
    </I>
  ),
  brush: () => (
    <I>
      <path d="M14 4l6 6-8 8-6-6z" />
      <path d="M6 12c-2 1-3 3-3 8 5 0 7-1 8-3" />
    </I>
  ),
  book: () => (
    <I>
      <path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 19V5" />
    </I>
  ),
  crown: () => (
    <I>
      <path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z" />
    </I>
  ),
  chevronUp: () => (
    <I>
      <path d="M6 15l6-6 6 6" />
    </I>
  ),
  chevronLeft: () => (
    <I>
      <path d="M15 6l-6 6 6 6" />
    </I>
  ),
  chevronRight: () => (
    <I>
      <path d="M9 6l6 6-6 6" />
    </I>
  ),
  first: () => (
    <I>
      <path d="M17 6l-6 6 6 6M7 6v12" />
    </I>
  ),
  last: () => (
    <I>
      <path d="M7 6l6 6-6 6M17 6v12" />
    </I>
  ),
  external: () => (
    <I>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </I>
  ),
  check: () => (
    <I>
      <path d="M5 12l5 5 9-10" />
    </I>
  ),
  upload: () => (
    <I>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </I>
  ),
  telegram: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M21.9 4.3l-3.1 14.8c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.6 12.9l-4.7-1.5c-1-.3-1-1 .2-1.5L20.6 2.9c.9-.3 1.6.2 1.3 1.4z" />
    </svg>
  ),
  x: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M17.8 3h3.2l-7 8 8.2 10h-6.4l-5-6.2L5 21H1.8l7.5-8.6L1.4 3h6.6l4.5 5.7zm-1.1 16.2h1.8L7.4 4.7H5.5z" />
    </svg>
  ),
  instagram: () => (
    <I>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
    </I>
  ),
};

/** The degent.club mark: a faceted green gem with a frog's eyes. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false" className="logo-mark">
      <defs>
        <linearGradient id="lm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7dffb6" />
          <stop offset="1" stopColor="#12b85e" />
        </linearGradient>
      </defs>
      <path d="M20 3l14 9-4 20H10L6 12z" fill="url(#lm-g)" />
      <path d="M20 3l-6 9h12zM6 12h8l6 20M34 12h-8l-6 20" fill="none" stroke="#0b0b0d" strokeOpacity=".35" strokeWidth="1.2" />
      <circle cx="14.5" cy="14" r="3.6" fill="#fff" />
      <circle cx="25.5" cy="14" r="3.6" fill="#fff" />
      <circle cx="15" cy="14.5" r="1.7" fill="#0b0b0d" />
      <circle cx="26" cy="14.5" r="1.7" fill="#0b0b0d" />
      <path d="M20 27l-5-2.6v5.2zM20 27l5-2.6v5.2z" fill="#0b0b0d" />
    </svg>
  );
}
