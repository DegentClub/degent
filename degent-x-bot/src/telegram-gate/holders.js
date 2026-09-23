// Client for the collection's holder API:
//   GET ${REGISTER_API_URL}/api/register/holder/:address  ->  { holds: number[] }
//
// Retries with exponential backoff and caches results for a short time so
// that verification and the 6-hourly re-check do not hammer the API.

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;

class HolderApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HolderApiError';
    this.status = status;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {Function} [opts.fetch]       fetch implementation (injectable)
 * @param {number} [opts.cacheTtlMs]    default 5 min
 * @param {number} [opts.retries]       attempts after the first
 * @param {number} [opts.backoffMs]     base backoff, doubles each retry
 * @param {Function} [opts.now]
 * @param {Function} [opts.sleep]
 * @param {object} [opts.logger]
 */
function createHolderClient(opts) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('createHolderClient: baseUrl required');
  const fetchImpl = opts.fetch || globalThis.fetch;
  const cacheTtlMs = opts.cacheTtlMs ?? 5 * 60 * 1000;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.logger;

  const cache = new Map(); // address -> { holds, at }
  let requests = 0;

  async function fetchOnce(address) {
    const url = `${baseUrl}/api/register/holder/${encodeURIComponent(address)}`;
    requests++;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) return [];
    if (!res.ok) throw new HolderApiError(`holder api returned ${res.status}`, res.status);
    const body = await res.json();
    if (!body || !Array.isArray(body.holds)) throw new HolderApiError('holder api returned no holds array', res.status);
    return body.holds.filter((n) => Number.isInteger(n));
  }

  /**
   * @param {string} address
   * @param {object} [o]  { fresh?: boolean }
   * @returns {Promise<number[]>} inscription numbers held (empty when none)
   */
  async function getHoldings(address, o = {}) {
    const key = address.toLowerCase();
    const hit = cache.get(key);
    if (!o.fresh && hit && now() - hit.at < cacheTtlMs) return hit.holds;

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const holds = await fetchOnce(address);
        cache.set(key, { holds, at: now() });
        return holds;
      } catch (err) {
        lastErr = err;
        const retryable = !(err instanceof HolderApiError) || err.status >= 500 || err.status === 429;
        if (!retryable || attempt === retries) break;
        const wait = backoffMs * 2 ** attempt;
        log?.warn({ address, attempt, wait, err: err.message }, 'holder api call failed, retrying');
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  return {
    getHoldings,
    holds: async (address, o) => (await getHoldings(address, o)).length > 0,
    invalidate: (address) => cache.delete(address.toLowerCase()),
    clear: () => cache.clear(),
    get requestCount() {
      return requests;
    },
  };
}

module.exports = { createHolderClient, HolderApiError };
