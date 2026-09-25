/** Inline SVG icons (no icon font, no dependency). Decorative: aria-hidden; the control carries the label. */
import type { ReactNode } from 'react';

function Svg({ children, size = 18, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={['icon', className].filter(Boolean).join(' ')}
    >
      {children}
    </svg>
  );
}

/** The club's green gem mark (site spec: logo mark, green gem/frog icon). */
export function GemMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="gem">
      <path d="M8 4h16l6 8-14 17L2 12z" fill="#2efc86" />
      <path d="M2 12h28M8 4l4 8 4-8 4 8 4-8M12 12l4 17 4-17" fill="none" stroke="#0b3d22" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export const Icon = {
  Rocket: () => (
    <Svg>
      <path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.1 2.1 0 0 0-2.9-.1z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z" />
      <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
    </Svg>
  ),
  Cart: () => (
    <Svg>
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L22 7H6" />
    </Svg>
  ),
  Menu: () => (
    <Svg size={22}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Svg>
  ),
  Close: () => (
    <Svg size={22}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
  ChevronUp: () => (
    <Svg>
      <path d="M6 15l6-6 6 6" />
    </Svg>
  ),
  ChevronLeft: () => (
    <Svg>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  ),
  ChevronRight: () => (
    <Svg>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),
  First: () => (
    <Svg>
      <path d="M17 18l-6-6 6-6M7 6v12" />
    </Svg>
  ),
  Last: () => (
    <Svg>
      <path d="M7 18l6-6-6-6M17 6v12" />
    </Svg>
  ),
  Check: () => (
    <Svg>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  External: () => (
    <Svg size={14}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  ),
  Home: () => (
    <Svg>
      <path d="M3 11l9-8 9 8M5 10v10h14V10" />
    </Svg>
  ),
  Info: () => (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </Svg>
  ),
  Grid: () => (
    <Svg>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </Svg>
  ),
  Frame: () => (
    <Svg>
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <rect x="7" y="7" width="10" height="10" />
    </Svg>
  ),
  List: () => (
    <Svg>
      <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </Svg>
  ),
  Scroll: () => (
    <Svg>
      <path d="M8 21h11a2 2 0 0 0 2-2v-1H10v1a2 2 0 0 1-4 0V5a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2h4M6 3h11a2 2 0 0 1 2 2v13" />
    </Svg>
  ),
  Pen: () => (
    <Svg>
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Svg>
  ),
  Palette: () => (
    <Svg>
      <path d="M12 3a9 9 0 1 0 0 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z" />
      <circle cx="7.5" cy="10.5" r="1" />
      <circle cx="11" cy="7" r="1" />
      <circle cx="15.5" cy="8" r="1" />
    </Svg>
  ),
  Sun: () => (
    <Svg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  ),
  Moon: () => (
    <Svg>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Svg>
  ),
  X: () => (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="icon">
      <path fill="currentColor" d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.3 4.7H5.5z" />
    </svg>
  ),
  Telegram: () => (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="icon">
      <path fill="currentColor" d="M21.9 4.3l-3.2 15.1c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13.1 1.4 11.6c-1-.3-1-1 .2-1.5L20.5 2.9c.9-.3 1.6.2 1.4 1.4z" />
    </svg>
  ),
  Instagram: () => (
    <Svg>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </Svg>
  ),
};
