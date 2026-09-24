/**
 * Newsletter sign-up: `POST {VITE_NEWSLETTER_URL}` with JSON `{ name, email, channel: 'email', source }`.
 * The endpoint is expected to create a `@bsh/notify` email subscription (double opt-in is the
 * endpoint's job). 2xx → subscribed; 409 → already subscribed; anything else → an honest error.
 * No mailto fallback: when the URL is not configured, the form says so and stays disabled.
 */
import type { NewsletterRequest, NewsletterResult, NewsletterService } from '../types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateNewsletter(req: NewsletterRequest): string | null {
  if (!req.name.trim()) return 'Please tell us your name.';
  if (req.name.trim().length > 80) return 'That name is too long (80 characters max).';
  if (!EMAIL_RE.test(req.email.trim())) return 'Please enter a valid e-mail address.';
  return null;
}

export function createHttpNewsletter(opts: { url: string; fetch?: FetchLike }): NewsletterService {
  const fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  return {
    configured: !!opts.url,
    async subscribe(req): Promise<NewsletterResult> {
      if (!opts.url) return { ok: false, message: 'Newsletter sign-up is not configured on this site yet.' };
      let res: Response;
      try {
        res = await fetchFn(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ name: req.name.trim(), email: req.email.trim(), channel: 'email', source: 'degent.club' }),
        });
      } catch {
        return { ok: false, message: 'We could not reach the newsletter service. Please try again later.' };
      }
      if (res.ok) return { ok: true, alreadySubscribed: false };
      if (res.status === 409) return { ok: true, alreadySubscribed: true };
      if (res.status === 429) return { ok: false, message: 'Too many attempts. Please wait a minute and try again.' };
      if (res.status === 400 || res.status === 422) return { ok: false, message: 'The newsletter service rejected that address.' };
      return { ok: false, message: `The newsletter service is unavailable (HTTP ${res.status}). Please try again later.` };
    },
  };
}
