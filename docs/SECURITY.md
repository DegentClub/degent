# Security notes

What the two API routes expose, how they are protected, and what an operator
still has to do.

## Threat model

- The app runs with an OpenAI key. Anyone who can call
  `/api/generate-frame` spends about $0.04 per call.
- The app fetches images server-side for the canvas. A server-side fetch of
  an arbitrary URL is an SSRF primitive: it can reach cloud metadata
  endpoints, internal services and localhost.
- Portraits are processed entirely in the browser and never uploaded.

## `/api/proxy-image`

Before the 0.2.0 release this route fetched any URL, returned it with
`Access-Control-Allow-Origin: *` and told browsers to cache it for a year.
Now (`src/lib/urlAllowlist.ts`, `src/app/api/proxy-image/route.ts`):

| Check | Rule |
|-------|------|
| Scheme | `https:` only |
| Credentials | `user:pass@` rejected |
| Port | only 443 |
| Host form | no IPv4/IPv6 literals at all |
| Private ranges | `localhost`, `*.localhost`, `*.local`, 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, 224+/multicast, `::1`, `fe80::/10`, `fc00::/7`, v4-mapped v6 |
| Allow-list | exact: `oaidalleapiprodscus.blob.core.windows.net`, `oaidata.blob.core.windows.net`, `openai.com`; suffix: `*.oaiusercontent.com`, `*.openai.com` |
| Redirects | `redirect: 'manual'`; any 3xx is a 502, never followed |
| Content type | `image/png|jpeg|webp|gif` only |
| Size | `Content-Length` > 10 MB → 413; body streamed and cut off at 10 MB |
| Timeout | 15 s |
| Caching | `Cache-Control: private, max-age=300` — DALL·E URLs expire in about an hour |
| CORS | no `Access-Control-Allow-Origin`; same-origin only |

The allow-list is host-based, so DNS rebinding of an allowed host to an
internal address is the residual risk. The hosts are OpenAI/Azure-operated;
if you must harden further, resolve and re-check the address at connect time
or run the app in a network namespace without access to internal ranges.

To add a host (for example if OpenAI moves image storage), edit
`ALLOWED_IMAGE_HOSTS` / `ALLOWED_IMAGE_HOST_SUFFIXES` and add a row to
`test/urlAllowlist.test.ts`.

## `/api/generate-frame`

Exactly one of two modes, decided by `ATELIER_API_KEY` (`src/lib/auth.ts`):

### api-key mode (`ATELIER_API_KEY` set)

- Header `x-atelier-key` must equal the configured value; comparison is
  constant-time.
- Missing/wrong → `401` with `WWW-Authenticate: x-atelier-key`.
- No per-IP limiting. The key is the gate.
- Generate a key with `openssl rand -hex 32`. Rotate by changing the env var.
- The browser UI does not send this header. Use this mode when the app sits
  behind a proxy that injects the header, or when you call the API directly.

### rate-limit mode (`ATELIER_API_KEY` unset)

- `SlidingWindowRateLimiter` (`src/lib/rateLimiter.ts`): **5 requests per
  10 minutes per client key**.
- Client key: first hop of `x-forwarded-for`, else `x-real-ip`, else
  `"unknown"` (so all un-proxied clients share one bucket — deliberate: it
  fails closed rather than open).
- Over the limit → `429` with `Retry-After`, `X-RateLimit-Limit`.
- The window lives in process memory. Restarting resets it; multiple
  instances each keep their own count. If you need a shared limiter, put
  one at the edge (Cloudflare, nginx `limit_req`, Vercel WAF) or switch to
  api-key mode.
- Trusting `x-forwarded-for` is only safe when the app is behind a proxy
  that overwrites it. If the app is directly exposed, clients can spoof the
  header and get fresh buckets; use api-key mode in that case.

### Input limits

- Body must be JSON with a string `description` ≤ 400 chars.
- The description is embedded in a fixed prompt; DALL·E's own content
  policy applies. Errors from OpenAI are logged server-side and returned as a
  generic `502`.
- `OPENAI_API_KEY` missing → `503` before any auth work.

## Headers

`next.config.js` sets `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`
on every response, and disables `X-Powered-By`.

## Dependencies

- Next.js is pinned to the latest 14.2.x (`^14.2.35`) which includes the
  fixes for the 2024–2025 middleware / cache-poisoning / DoS advisories
  affecting 14.2.5. Run `npm audit` before releases.
- `images.domains` (deprecated) was replaced with `images.remotePatterns`.

## Reporting

Open a private issue or contact the maintainers directly; do not post
exploit details publicly before a fix ships.
