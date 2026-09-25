/** Window scroll position as React state (sticky-header meters, scroll-progress bar, back-to-top). */
import { useEffect, useState } from 'react';

export interface ScrollState {
  y: number;
  /** 0..1 of the scrollable height. */
  progress: number;
}

function read(): ScrollState {
  if (typeof window === 'undefined') return { y: 0, progress: 0 };
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return { y, progress: max > 0 ? Math.min(1, y / max) : 0 };
}

export function useScroll(): ScrollState {
  const [s, setS] = useState<ScrollState>(read);
  useEffect(() => {
    let frame = 0;
    const on = () => {
      if (frame) return;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
      frame = raf(() => {
        frame = 0;
        setS(read());
      });
    };
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, []);
  return s;
}

/** Scroll to the top, instantly when the viewer prefers reduced motion. */
export function scrollToTop(): void {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
}
