/**
 * Dark is the club's identity (site spec "Visual identity"); a light theme is opt-in from the menu.
 * The choice is a per-viewer convenience in localStorage (try/catch: private windows may refuse it).
 */
import type { KeyValueStore } from './recovery';

export type Theme = 'dark' | 'light';
export const THEME_KEY = 'degent.club/theme/v1';

export function loadTheme(store: KeyValueStore | null): Theme {
  try {
    return store?.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveTheme(theme: Theme, store: KeyValueStore | null): void {
  try {
    store?.setItem(THEME_KEY, theme);
  } catch {
    /* storage refused: the theme still applies for this visit */
  }
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f6f6f3' : '#000000');
}
