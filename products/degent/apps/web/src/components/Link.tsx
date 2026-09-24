import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { navigate, routePath, type Route } from '../lib/router';

/** In-app hash link: a real <a href="#/…"> (middle-click, copy link) that also routes without a page load. */
export function Link({
  to,
  children,
  onClick,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string | Route; children: ReactNode }) {
  const href = typeof to === 'string' ? to : routePath(to);
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
