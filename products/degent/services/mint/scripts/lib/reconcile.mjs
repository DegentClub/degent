/**
 * reconcile: one certified count for the collection (site-spec "Known defects": three conflicting counts).
 * Pure except for the injected `fetch`; used by scripts/reconcile-count.mjs and its tests.
 *
 * Sources compared:
 *   - the roster (data/roster.json: the Gallery members, `sizeKb` from the marketplace manifest, `bytes` derived),
 *   - optionally an exported list of inscription ids (Magic Eden or elsewhere),
 *   - optionally ord's recursive endpoint `GET <ord>/r/inscription/<id>` → `content_length` (the Register's measure),
 *   - the numbers the site claims (defaults: 4,027 minted / 1,470 MB).
 */

/** What degent.club shows today (site-spec "Known defects"). */
export const DEFAULT_CLAIMS = Object.freeze({ label: 'site', count: 4027, megabytes: 1470 });
/** The third conflicting figure named in the site spec. */
export const INTERNAL_ANALYSIS = Object.freeze({ label: 'internal analysis', count: 4113, megabytes: 1508 });
const ID = /^[0-9a-f]{64}i\d+$/;
const MB = 1e6;
const MIB = 1024 * 1024;

// ------------------------------------------------------------------ inputs

/** Roster JSON (`{ members: [{ n, inscriptionId, sizeKb, bytes }] }`) or the legacy manifest array. */
export function normaliseRoster(raw) {
  const list = Array.isArray(raw) ? raw : raw?.members;
  if (!Array.isArray(list)) throw new Error('roster must be { members: [...] } or an array');
  return list.map((m, i) => {
    const nm = /^Degent #(\d+)$/.exec(String(m.name ?? ''));
    const n = Number.isSafeInteger(m.n) ? m.n : nm ? Number(nm[1]) : i + 1;
    const sizeKb = Number(m.sizeKb ?? m.size_kb);
    return {
      n,
      id: String(m.inscriptionId ?? m.inscription_id ?? m.id ?? ''),
      sizeKb: Number.isFinite(sizeKb) ? sizeKb : null,
      bytes: Number.isSafeInteger(m.bytes) ? m.bytes : null,
    };
  });
}

/**
 * Inscription ids from an export: a JSON array of strings or of objects (`id`, `inscriptionId`, `inscription_id`,
 * `tokenId`), an object wrapping such an array (`tokens`, `items`, `members`, `inscriptions`), or plain text with one
 * id per line / separated by commas or whitespace. Order is kept; nothing is de-duplicated here.
 */
export function parseExport(text) {
  const trimmed = String(text).trim();
  let values;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let j = JSON.parse(trimmed);
    if (!Array.isArray(j)) j = j.tokens ?? j.items ?? j.members ?? j.inscriptions ?? j.ids;
    if (!Array.isArray(j)) throw new Error('export JSON must be an array or wrap one (tokens/items/members/inscriptions/ids)');
    values = j.map((x) => (typeof x === 'string' ? x : (x?.id ?? x?.inscriptionId ?? x?.inscription_id ?? x?.tokenId ?? '')));
  } else values = trimmed.split(/[\s,]+/);
  return values.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

// ------------------------------------------------------------------ ord (injectable fetch, cached)

/**
 * `content_length` per id from ord's recursive endpoint. `cache` is a plain object (id -> { content_length }) that is
 * read first and filled in place, so a re-run only asks for new ids. Failures are returned, never thrown.
 */
export async function fetchOrdSizes(ids, { baseUrl, fetch: fetchFn = globalThis.fetch, cache = {}, concurrency = 8 }) {
  const base = String(baseUrl).replace(/\/$/, '');
  const sizes = new Map();
  const failures = [];
  const todo = [];
  for (const id of new Set(ids)) {
    const hit = cache[id];
    if (hit && Number.isSafeInteger(hit.content_length)) sizes.set(id, hit.content_length);
    else todo.push(id);
  }
  let cursor = 0;
  let fetched = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const id = todo[cursor++];
      try {
        const res = await fetchFn(`${base}/r/inscription/${id}`, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!Number.isSafeInteger(j?.content_length)) throw new Error('no content_length in response');
        sizes.set(id, j.content_length);
        cache[id] = { content_length: j.content_length };
        fetched++;
      } catch (e) {
        failures.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
  failures.sort((a, b) => a.id.localeCompare(b.id));
  return { sizes, failures, fetched, cached: sizes.size - fetched };
}

// ------------------------------------------------------------------ analysis

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const units = (bytes) => ({ bytes, MB: round(bytes / MB), MiB: round(bytes / MIB) });

function groupDuplicates(pairs) {
  const by = new Map();
  for (const [key, n] of pairs) by.set(key, [...(by.get(key) ?? []), n]);
  return [...by.entries()].filter(([, ns]) => ns.length > 1).map(([key, ns]) => ({ key, n: ns }));
}

/**
 * Compare everything and explain each discrepancy class. `ord` is the result of fetchOrdSizes (or null).
 * Deterministic: the same inputs give the same report.
 */
export function reconcile({ roster: rawRoster, exportIds = null, ord = null, ordUrl = null, claims = [DEFAULT_CLAIMS, INTERNAL_ANALYSIS] }) {
  const roster = normaliseRoster(rawRoster);
  const claimList = (Array.isArray(claims) ? claims : [claims]).map((c, i) => ({ label: c.label ?? (i === 0 ? 'site' : `claim ${i + 1}`), count: Number(c.count), megabytes: Number(c.megabytes) }));
  for (const c of claimList)
    if (!Number.isFinite(c.count) || !Number.isFinite(c.megabytes) || c.megabytes <= 0) throw new Error(`claim "${c.label}" needs a numeric count and positive megabytes`);
  const discrepancies = [];

  // --- roster integrity
  const malformed = roster.filter((m) => !ID.test(m.id)).map((m) => ({ n: m.n, id: m.id }));
  const dupIds = groupDuplicates(roster.map((m) => [m.id, m.n])).map((d) => ({ id: d.key, n: d.n }));
  const dupNumbers = groupDuplicates(roster.map((m) => [m.n, m.n])).map((d) => d.key);
  const numbers = [...new Set(roster.map((m) => m.n))].sort((a, b) => a - b);
  const maxN = numbers.length ? numbers[numbers.length - 1] : 0;
  const present = new Set(numbers);
  const gaps = [];
  for (let n = 1; n <= maxN; n++) if (!present.has(n)) gaps.push(n);
  const uniqueValid = new Set(roster.filter((m) => ID.test(m.id)).map((m) => m.id));

  if (dupIds.length)
    discrepancies.push({
      class: 'duplicate-in-roster',
      count: dupIds.reduce((s, d) => s + d.n.length - 1, 0),
      explanation: 'The same inscription id is listed under more than one Degent number. Each extra listing inflates a naive row count by one; the certified count counts the inscription once.',
      examples: dupIds.slice(0, 10),
    });
  if (dupNumbers.length || gaps.length || malformed.length)
    discrepancies.push({
      class: 'roster-numbering',
      count: dupNumbers.length + gaps.length + malformed.length,
      explanation: 'Degent numbers must run 1..N without gaps or repeats and every id must be <txid>i<index>; otherwise "highest number" and "number of rows" disagree with the number of inscriptions.',
      examples: { duplicateNumbers: dupNumbers.slice(0, 10), gaps: gaps.slice(0, 10), malformed: malformed.slice(0, 10) },
    });

  // --- export comparison
  let exportSection = null;
  if (exportIds) {
    const exp = exportIds.map(String);
    const expSet = new Set(exp);
    const expDup = groupDuplicates(exp.map((id, i) => [id, i])).map((d) => ({ id: d.key, times: d.n.length }));
    const expBad = [...expSet].filter((id) => !ID.test(id));
    const missing = roster.filter((m) => ID.test(m.id) && !expSet.has(m.id)).map((m) => ({ n: m.n, id: m.id }));
    const rosterIds = new Set(roster.map((m) => m.id));
    const extra = [...expSet].filter((id) => ID.test(id) && !rosterIds.has(id)).sort();
    exportSection = { rows: exp.length, unique: expSet.size, duplicates: expDup, malformed: expBad, missingFromExport: missing, extraInExport: extra };
    if (missing.length)
      discrepancies.push({
        class: 'missing-from-export',
        count: missing.length,
        explanation: 'Roster members the export does not list. Marketplace exports only show inscriptions the marketplace indexed or has not hidden (delisted, flagged, or added after its collection snapshot), so a marketplace count is a lower bound, not the membership.',
        examples: missing.slice(0, 10),
      });
    if (extra.length)
      discrepancies.push({
        class: 'extra-in-export',
        count: extra.length,
        explanation: 'Ids in the export that are not Degents in the roster: other inscriptions the marketplace grouped into the collection (e.g. the parent, test mints, or look-alikes). They are not members until the Register lists them.',
        examples: extra.slice(0, 10),
      });
    if (expDup.length || expBad.length)
      discrepancies.push({
        class: 'export-hygiene',
        count: expDup.length + expBad.length,
        explanation: 'Repeated or malformed rows in the export (pagination overlaps, header lines). Counting rows instead of unique ids over-counts.',
        examples: { duplicates: expDup.slice(0, 10), malformed: expBad.slice(0, 10) },
      });
  }

  // --- bytes
  const firstIdx = new Map();
  roster.forEach((m) => {
    if (!firstIdx.has(m.id)) firstIdx.set(m.id, m);
  });
  // Every byte figure is over UNIQUE inscriptions (a duplicated row is one inscription).
  const uniqueMembers = [...firstIdx.values()];
  const sumKb = uniqueMembers.reduce((s, m) => s + (m.sizeKb ?? 0), 0);
  const estimate = uniqueMembers.reduce((s, m) => s + (m.bytes ?? (m.sizeKb !== null ? Math.round(m.sizeKb * 1024) : 0)), 0);
  const rosterBytes = {
    sizeKbSum: round(sumKb, 2),
    estimate: units(estimate),
    fromSizeKbAsKB: units(Math.round(sumKb * 1000)),
    note: '`sizeKb` comes from the marketplace manifest in KiB with two decimals, so any total from it is an estimate (±5 bytes per member); `estimate` sums the roster `bytes` (sizeKb×1024 rounded).',
  };

  let ordSection = null;
  if (ord) {
    const rows = uniqueMembers.filter((m) => ord.sizes.has(m.id));
    const total = rows.reduce((s, m) => s + ord.sizes.get(m.id), 0);
    const mismatches = rows
      .filter((m) => m.bytes !== null && Math.abs(ord.sizes.get(m.id) - m.bytes) > 6)
      .map((m) => ({ n: m.n, id: m.id, rosterBytes: m.bytes, ordContentLength: ord.sizes.get(m.id), delta: ord.sizes.get(m.id) - m.bytes }));
    ordSection = {
      url: ordUrl,
      covered: rows.length,
      of: uniqueMembers.length,
      fetched: ord.fetched,
      cached: ord.cached,
      failures: ord.failures,
      contentLength: units(total),
      mismatches,
    };
    if (mismatches.length)
      discrepancies.push({
        class: 'size-mismatch-vs-ord',
        count: mismatches.length,
        explanation: "The manifest's size differs from ord's content_length by more than the KiB rounding (±6 bytes). ord's number is the bytes actually in the envelope; the manifest was hand-maintained.",
        examples: mismatches.slice(0, 10),
      });
    if (ord.failures.length)
      discrepancies.push({
        class: 'ord-unavailable',
        count: ord.failures.length,
        explanation: 'ord could not answer for these ids (unknown to that index, not yet indexed, or HTTP errors). Until they resolve the byte total is a lower bound; re-run (answers are cached).',
        examples: ord.failures.slice(0, 10),
      });
  }

  // --- claims
  const certifiedCount = uniqueValid.size;
  const bytesSource = ordSection && ordSection.covered === ordSection.of ? 'ord content_length (complete)' : 'roster sizeKb×1024 (estimate)';
  const certifiedBytes = ordSection && ordSection.covered === ordSection.of ? ordSection.contentLength.bytes : rosterBytes.estimate.bytes;

  const evaluate = (label, claimCount, claimMb) => {
    const countDelta = certifiedCount - claimCount;
    const beyond = uniqueMembers.filter((m) => m.n > claimCount).map((m) => m.n);
    const countExplanation =
      countDelta === 0
        ? 'The claimed count equals the certified count.'
        : countDelta > 0
          ? `The ${label} count is ${countDelta} lower than the roster. The roster lists ${beyond.length} member(s) numbered above ${claimCount}` +
            (beyond.length ? ` (#${beyond[0]}–#${beyond[beyond.length - 1]})` : '') +
            ': a stale snapshot taken before they were added. Numbers are unique and contiguous, so the highest number is the count.'
          : `The ${label} count is ${-countDelta} higher than the unique inscriptions in the roster: it counts something that is not a distinct Degent (the club parent, a duplicate row, a test mint) or members the roster lacks.`;
    const prefixKb = uniqueMembers.filter((m) => m.n <= claimCount && m.sizeKb !== null).reduce((s, m) => s + m.sizeKb, 0);
    const scope = Math.min(claimCount, certifiedCount);
    const candidates = [
      { label: `bytes/10^6 (MB) of all ${certifiedCount}`, value: certifiedBytes / MB },
      { label: `bytes/2^20 (MiB) of all ${certifiedCount}`, value: certifiedBytes / MIB },
      { label: `sizeKb/1000 (KiB read as KB) of all ${certifiedCount}`, value: sumKb / 1000 },
      { label: `bytes/10^6 (MB) of #1–#${scope}`, value: (prefixKb * 1024) / MB },
      { label: `bytes/2^20 (MiB) of #1–#${scope}`, value: (prefixKb * 1024) / MIB },
    ].map((c) => ({ ...c, value: round(c.value), relativeError: round(Math.abs(c.value - claimMb) / claimMb, 4) }));
    const best = [...candidates].sort((x, y) => x.relativeError - y.relativeError)[0];
    const bytesExplanation =
      best.relativeError <= 0.005
        ? `The ${label} figure ${fmt(claimMb)} "MB" matches ${best.label} (${fmt(best.value)}) within ${round(best.relativeError * 100, 2)}%. ` +
          (/MiB/.test(best.label) ? `It is a binary total (MiB) labelled "MB"; in decimal megabytes the same bytes are ${fmt(units(certifiedBytes).MB)} MB. ` : '') +
          (/#1–#/.test(best.label) && scope < certifiedCount ? 'It was computed over the stale member list, so it misses the members added since. ' : '') +
          (/KiB read as KB/.test(best.label) ? 'It mixes units: the manifest sizes are KiB; dividing their sum by 1000 understates decimal MB by 2.3% (and overstates MiB by 2.4%). ' : '') +
          'State bytes with the unit and the source (ord content_length) from now on.'
        : `No simple unit or snapshot explains the ${label} figure ${fmt(claimMb)} (closest: ${best.label} = ${fmt(best.value)}, ${round(best.relativeError * 100, 2)}% off). Treat it as unsupported and replace it with the certified figure.`;
    if (countDelta !== 0)
      discrepancies.push({ class: countDelta > 0 ? 'stale-count' : 'over-count', source: label, count: Math.abs(countDelta), explanation: countExplanation, examples: beyond.slice(0, 10) });
    if (Math.abs(claimMb - units(certifiedBytes).MB) / claimMb > 0.005)
      discrepancies.push({
        class: /MiB/.test(best.label) || /KiB read as KB/.test(best.label) ? 'unit-mismatch' : best.relativeError <= 0.005 ? 'stale-bytes' : 'unsupported-bytes',
        source: label,
        count: 1,
        explanation: bytesExplanation,
        examples: [best],
      });
    return {
      source: label,
      count: { claimed: claimCount, certified: certifiedCount, delta: countDelta, explanation: countExplanation },
      megabytes: { claimed: claimMb, certified: units(certifiedBytes), bytesSource, candidates, bestMatch: best.label, explanation: bytesExplanation },
    };
  };
  const claimResults = claimList.map((c) => evaluate(c.label, Number(c.count), Number(c.megabytes)));

  return {
    version: 1,
    kind: 'degent.club/count-reconciliation',
    inputs: { rosterRows: roster.length, exportRows: exportIds ? exportIds.length : null, ordUrl, claims: claimList },
    certified: {
      count: certifiedCount,
      bytes: certifiedBytes,
      MB: units(certifiedBytes).MB,
      MiB: units(certifiedBytes).MiB,
      bytesSource,
      statement: `${fmt(certifiedCount)} Degents, ${fmt(units(certifiedBytes).MB)} MB (${fmt(units(certifiedBytes).MiB)} MiB) of inscription content — ${bytesSource}.`,
    },
    roster: {
      rows: roster.length,
      uniqueIds: uniqueValid.size,
      duplicateIds: dupIds,
      duplicateNumbers: dupNumbers,
      gaps,
      malformed,
      highestNumber: maxN,
    },
    export: exportSection,
    bytes: { roster: rosterBytes, ord: ordSection },
    claims: claimResults,
    discrepancies,
  };
}

// ------------------------------------------------------------------ markdown

/** 1234567.891 -> "1,234,567.89" (no locale data needed, so the report is byte-identical everywhere). */
const fmt = (n) => {
  if (typeof n !== 'number') return String(n);
  const [i, f] = (Math.round(n * 100) / 100).toString().split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
};

export function toMarkdown(r) {
  const L = [];
  L.push('# degent.club — certified count', '');
  L.push(`**${r.certified.statement}**`, '');
  L.push('| Source | Count | Bytes | MB (10^6) | MiB (2^20) |', '|---|---:|---:|---:|---:|');
  L.push(`| Roster (\`data/roster.json\`, sizeKb×1024) | ${fmt(r.roster.uniqueIds)} | ${fmt(r.bytes.roster.estimate.bytes)} | ${fmt(r.bytes.roster.estimate.MB)} | ${fmt(r.bytes.roster.estimate.MiB)} |`);
  if (r.bytes.ord)
    L.push(`| ord \`/r/inscription\` content_length (${fmt(r.bytes.ord.covered)}/${fmt(r.bytes.ord.of)} answered) | ${fmt(r.bytes.ord.covered)} | ${fmt(r.bytes.ord.contentLength.bytes)} | ${fmt(r.bytes.ord.contentLength.MB)} | ${fmt(r.bytes.ord.contentLength.MiB)} |`);
  if (r.export) L.push(`| Export (unique ids) | ${fmt(r.export.unique)} | | | |`);
  for (const c of r.claims) L.push(`| Claim: ${c.source} | ${fmt(c.count.claimed)} | | ${fmt(c.megabytes.claimed)} "MB" | |`);
  L.push('', '## Claims', '');
  for (const c of r.claims) {
    L.push(`### ${c.source}: ${fmt(c.count.claimed)} / ${fmt(c.megabytes.claimed)} MB`, '');
    L.push(`- Count: ${c.count.explanation}`, `- Bytes: ${c.megabytes.explanation}`, '');
    L.push('| Candidate | Value | Off by |', '|---|---:|---:|');
    for (const x of c.megabytes.candidates) L.push(`| ${x.label} | ${fmt(x.value)} | ${fmt(x.relativeError * 100)}% |`);
    L.push('');
  }
  L.push('## Discrepancies', '');
  if (!r.discrepancies.length) L.push('None.');
  for (const d of r.discrepancies) {
    L.push(`### ${d.class} (${fmt(d.count)})`, '', d.explanation, '');
    if (Array.isArray(d.examples) && d.examples.length) L.push('Examples: `' + JSON.stringify(d.examples.slice(0, 5)) + '`', '');
    else if (d.examples && !Array.isArray(d.examples)) L.push('Examples: `' + JSON.stringify(d.examples) + '`', '');
  }
  L.push('## Method', '');
  L.push('- Count: unique, well-formed inscription ids in the roster (numbers 1..N, contiguous).');
  L.push('- Bytes: ord `GET /r/inscription/<id>` → `content_length` summed over the roster when every id answered; otherwise the roster estimate (manifest `sizeKb` × 1024), labelled as such.');
  L.push('- Re-run: `node products/degent/services/mint/scripts/reconcile-count.mjs --ord <your ord> [--export ids.json] --out report` (answers cached).');
  return `${L.join('\n')}\n`;
}
