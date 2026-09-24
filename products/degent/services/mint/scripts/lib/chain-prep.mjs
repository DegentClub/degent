/**
 * chain-prep: pure helpers shared by prepare-parent.mjs and prepare-gallery.mjs (docs/LAUNCH-CHAIN-SETUP.md).
 * No network, no keys, no clock: the same inputs always produce the same bytes.
 *
 * - A minimal deterministic CBOR encoder/decoder (RFC 8949 subset: unsigned/negative ints, text, bytes,
 *   arrays, maps with text keys in insertion order, booleans, null) for ord's `--cbor-metadata` files.
 * - The Club parent charter page and metadata (docs/REGISTER.md §1.1).
 * - The Gallery document, its SHA-256 and the exact BIP-322 message the owner signs (docs/REGISTER.md §1.2).
 * - `ord wallet inscribe` / `ord wallet send` command builders and the machine-readable plan.
 */
import { createHash } from 'node:crypto';

export const CLUB_NAME = 'Decentralized Gentlemen Club';
export const CHARTER_SIZE = 10_000;
export const GALLERY_SIZE = 4112;
export const DEFAULT_POSTAGE_SATS = 10_000;
/** Charter page budget (the parent is the club's face on every explorer; keep it tiny). */
export const MAX_CHARTER_BYTES = 2048;
/**
 * Gallery content budget: a reveal must stay under the 400,000 WU standardness limit, so the envelope stays
 * below the standard-lane ceiling the collection already uses (STANDARD_MAX_BYTES in @bsh/degent-mint-sdk).
 */
export const MAX_GALLERY_BYTES = 390_000;
/** ord pushes metadata in 520-byte chunks; keep it to a handful of chunks. */
export const MAX_METADATA_BYTES = 4096;
export const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];

const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/;

// ------------------------------------------------------------------ args

/** `--key value` / `--flag` parsing, identical to the other scripts in this directory. */
export function parseArgs(argv) {
  return Object.fromEntries(
    argv.reduce((acc, a, i, arr) => {
      if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] === undefined || arr[i + 1].startsWith('--') ? true : arr[i + 1]]);
      return acc;
    }, []),
  );
}

// ------------------------------------------------------------------ hashing

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const utf8 = (s) => new TextEncoder().encode(s);

// ------------------------------------------------------------------ CBOR

function head(major, n) {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const big = BigInt(n);
  const out = [m | 27];
  for (let i = 7; i >= 0; i--) out.push(Number((big >> BigInt(i * 8)) & 0xffn));
  return out;
}

/** Deterministic CBOR (definite lengths, shortest integer heads, map keys in insertion order). */
export function encodeCbor(value) {
  const out = [];
  const enc = (v) => {
    if (v === null) out.push(0xf6);
    else if (v === false) out.push(0xf4);
    else if (v === true) out.push(0xf5);
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new TypeError(`CBOR: only safe integers are supported (${v})`);
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    } else if (typeof v === 'string') {
      const b = utf8(v);
      out.push(...head(3, b.length), ...b);
    } else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v);
    else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(enc);
    } else if (typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      out.push(...head(5, entries.length));
      for (const [k, x] of entries) {
        enc(k);
        enc(x);
      }
    } else throw new TypeError(`CBOR: unsupported value ${String(v)}`);
  };
  enc(value);
  return Uint8Array.from(out);
}

/** Decoder for the same subset (verification of what ord will store under /r/metadata/<id>). */
export function decodeCbor(bytes) {
  let p = 0;
  const need = (n) => {
    if (p + n > bytes.length) throw new RangeError('CBOR: truncated');
  };
  const arg = (info) => {
    if (info < 24) return info;
    const len = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!len) throw new RangeError(`CBOR: unsupported additional info ${info}`);
    need(len);
    let n = 0n;
    for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(bytes[p++]);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('CBOR: integer too large');
    return Number(n);
  };
  const dec = () => {
    need(1);
    const b = bytes[p++];
    const major = b >> 5;
    const info = b & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new RangeError(`CBOR: unsupported simple value ${info}`);
    }
    const n = arg(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2:
        need(n);
        return bytes.slice(p, (p += n));
      case 3:
        need(n);
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(p, (p += n)));
      case 4:
        return Array.from({ length: n }, dec);
      case 5: {
        const o = {};
        for (let i = 0; i < n; i++) {
          const k = dec();
          if (typeof k !== 'string') throw new TypeError('CBOR: only text map keys are supported');
          o[k] = dec();
        }
        return o;
      }
      default:
        throw new RangeError(`CBOR: unsupported major type ${major}`);
    }
  };
  const v = dec();
  if (p !== bytes.length) throw new RangeError('CBOR: trailing bytes');
  return v;
}

// ------------------------------------------------------------------ parent (REGISTER.md §1.1)

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 10000 -> "10,000" without depending on the runtime's locale data. */
const thousands = (v) => String(Math.trunc(Number(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The charter page: self-contained, link-free, no scripts, no external resources. */
export function charterHtml({ name = CLUB_NAME, charter = CHARTER_SIZE, gallerySize = GALLERY_SIZE } = {}) {
  const n = thousands(charter);
  const g = thousands(gallerySize);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(name)}</title>`,
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#fff;font:16px/1.5 system-ui,sans-serif}',
    'main{max-width:34em;padding:2em;border:3px solid #c9a227;text-align:center}h1{margin:0 0 .5em;color:#2efc86}',
    'p{color:#ffffffbd}small{color:#c9a227;letter-spacing:.2em}</style></head>',
    '<body><main>',
    `<small>DEGEN · DEGENT · REGEN</small><h1>${escapeHtml(name)}</h1>`,
    `<p>This inscription is the parent of the club. A Degent is a Pepe in a tuxedo with a bowtie, framed, with a placard.</p>`,
    `<p>The first ${g} Degents are listed in the Gallery, a signed child of this inscription. Every later Degent is a child of this inscription, admitted by a vote of the members.</p>`,
    `<p>Charter: ${n} Degents.</p>`,
    '</main></body></html>',
  ].join('\n');
}

/**
 * Parent metadata. REGISTER.md §1.1 once listed a `register` field "filled after 1.2", but inscription metadata is
 * immutable and the Gallery can only be inscribed after the parent exists; the Gallery is found as the parent's
 * child (ord `/r/children/<parent>`) and announced as GALLERY_INSCRIPTION_ID (GET /v1/register).
 */
export function parentMetadata({ name = CLUB_NAME, charter = CHARTER_SIZE } = {}) {
  return { name, charter: String(charter) };
}

// ------------------------------------------------------------------ gallery (REGISTER.md §1.2)

/**
 * `{ version: 1, members: [{ n, id }] }` for n = 1..count, ordered by n. Refuses gaps, duplicate numbers,
 * duplicate ids and malformed ids: a Gallery is forever.
 */
export function buildGallery(roster, count = GALLERY_SIZE) {
  const members = Array.isArray(roster) ? roster : roster?.members;
  if (!Array.isArray(members)) throw new Error('roster must be { members: [...] } or an array');
  const byN = new Map();
  for (const m of members) {
    const n = m.n;
    const id = m.inscriptionId ?? m.id;
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`bad member number: ${n}`);
    if (n > count) continue;
    if (byN.has(n)) throw new Error(`duplicate member number ${n}`);
    if (typeof id !== 'string' || !INSCRIPTION_ID.test(id)) throw new Error(`bad inscription id for #${n}: ${id}`);
    byN.set(n, id);
  }
  const out = [];
  for (let n = 1; n <= count; n++) {
    if (!byN.has(n)) throw new Error(`roster is missing #${n}`);
    out.push({ n, id: byN.get(n) });
  }
  const firstSeen = new Map();
  for (const m of out) {
    if (firstSeen.has(m.id)) throw new Error(`duplicate inscription id ${m.id} (#${firstSeen.get(m.id)} and #${m.n})`);
    firstSeen.set(m.id, m.n);
  }
  return { version: 1, members: out };
}

/** Canonical bytes: compact JSON, keys in the order above, no trailing newline. */
export const galleryBytes = (gallery) => utf8(JSON.stringify(gallery));

/**
 * The exact BIP-322 message the owner signs with the announced signing address (REGISTER.md §1.2).
 * One line, ASCII, so every wallet signs the same bytes.
 */
export function galleryMessage(sha256hex, parent, count = GALLERY_SIZE) {
  if (!/^[0-9a-f]{64}$/.test(sha256hex)) throw new Error('sha256 must be 64 lowercase hex characters');
  if (!isInscriptionId(parent)) throw new Error('parent must be an inscription id');
  return `degent.club Gallery v1: ${count} members, sha256 ${sha256hex}, parent ${parent}`;
}

/** Gallery metadata: the proof a forked gallery cannot copy (the signature commits to the content hash and parent). */
export function galleryMetadata({ parent, sha256, count = GALLERY_SIZE, signingAddress, signature }) {
  return {
    kind: 'degent.club/gallery',
    version: 1,
    parent,
    count,
    sha256,
    message: galleryMessage(sha256, parent, count),
    signer: signingAddress,
    signature,
  };
}

// ------------------------------------------------------------------ commands

/** POSIX single-quote a value when it is not a plain token (placeholders like <X> are quoted too). */
export const shq = (s) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

export function ordInscribeCommand({ network, feeRate, postage, file, cborMetadata, destination, parent }) {
  const parts = ['ord', '--chain', network, 'wallet', 'inscribe', '--fee-rate', String(feeRate), '--postage', `${postage}sat`];
  if (parent) parts.push('--parent', parent);
  parts.push('--file', file, '--cbor-metadata', cborMetadata, '--destination', destination);
  return parts.map(shq).join(' ');
}

export function ordSendCommand({ network, feeRate, address, inscription }) {
  return ['ord', '--chain', network, 'wallet', 'send', '--fee-rate', String(feeRate), address, inscription].map(shq).join(' ');
}

// ------------------------------------------------------------------ validation of CLI inputs

export function requireNetwork(v) {
  if (!NETWORKS.includes(v)) throw new Error(`--network must be one of ${NETWORKS.join(', ')}`);
  return v;
}

export function requireFeeRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.round(n * 1000) !== n * 1000) throw new Error('--fee-rate must be a positive sat/vB with at most 3 decimals');
  return n;
}

export function requirePostage(v) {
  const n = v === undefined ? DEFAULT_POSTAGE_SATS : Number(v);
  if (!Number.isSafeInteger(n) || n < 546) throw new Error('--postage must be an integer >= 546 sats');
  return n;
}

export const isInscriptionId = (s) => typeof s === 'string' && INSCRIPTION_ID.test(s);

/** File descriptor for plan.json. */
export const fileEntry = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256Hex(bytes) });

// ------------------------------------------------------------------ plans

const PH = {
  ordWallet: '<ORD_WALLET_ADDRESS>',
  collection: '<COLLECTION_ADDRESS>',
  parent: '<PARENT_INSCRIPTION_ID>',
  gallery: '<GALLERY_INSCRIPTION_ID>',
  signer: '<SIGNING_ADDRESS>',
};

const check = (name, value, max) => ({ name, value, max, ok: value <= max });

/**
 * Everything the owner needs to inscribe the Club parent: files (name -> bytes) and plan.json.
 *
 * Custody order matters: ord's `--parent` needs the parent in the ord wallet that inscribes the Gallery, while the
 * mint service needs it at COLLECTION_ADDRESS (the policy signer's key, which only signs mint reveals). So the parent
 * is inscribed to the owner's ord wallet (`destination`), the Gallery is inscribed as its child, and only then is the
 * parent sent to COLLECTION_ADDRESS; PARENT_OUTPOINT is where that send puts it.
 */
export function prepareParent(opts) {
  const network = requireNetwork(opts.network);
  const feeRate = requireFeeRate(opts.feeRate);
  const postage = requirePostage(opts.postage);
  const destination = opts.destination || PH.ordWallet;
  const collectionAddress = opts.collectionAddress || PH.collection;
  const name = opts.name || CLUB_NAME;
  const charter = opts.charter === undefined ? CHARTER_SIZE : Number(opts.charter);
  if (!Number.isSafeInteger(charter) || charter < GALLERY_SIZE) throw new Error(`--charter must be an integer >= ${GALLERY_SIZE}`);

  const html = utf8(charterHtml({ name, charter }));
  const meta = parentMetadata({ name, charter });
  const cbor = encodeCbor(meta);
  const limits = [check('charter.html bytes', html.length, MAX_CHARTER_BYTES), check('parent.metadata.cbor bytes', cbor.length, MAX_METADATA_BYTES)];
  const bad = limits.filter((l) => !l.ok);
  if (bad.length) throw new Error(`size limits exceeded: ${bad.map((l) => `${l.name} ${l.value} > ${l.max}`).join('; ')}`);

  const files = {
    'charter.html': html,
    'parent.metadata.cbor': cbor,
    'parent.metadata.json': utf8(`${JSON.stringify(meta, null, 2)}\n`),
  };
  const inscribe = ordInscribeCommand({ network, feeRate, postage, file: 'charter.html', cborMetadata: 'parent.metadata.cbor', destination });
  const plan = {
    version: 1,
    kind: 'degent.club/chain-setup/parent',
    network,
    cwd: 'the --out directory (commands use bare file names)',
    inputs: { name, charter, feeRate, postageSats: postage, destination, collectionAddress },
    files: Object.entries(files).map(([path, bytes]) => fileEntry(path, bytes)),
    limits,
    fees: 'the dry-run step prints the exact commit and reveal fees (ord computes them; nothing here re-derives weight)',
    steps: [
      {
        id: 'parent.dry-run',
        who: 'owner',
        run: `${inscribe} --dry-run`,
        expect: 'JSON with commit/reveal fees and total_fees; nothing is broadcast',
      },
      {
        id: 'parent.inscribe',
        who: 'owner',
        run: inscribe,
        expect: 'JSON {commit, reveal, inscriptions:[{id, location}]}; PARENT_INSCRIPTION_ID = inscriptions[0].id (= <reveal>i0)',
        verify: [
          { run: `curl -s $ORD_URL/content/${PH.parent} | sha256sum`, expect: sha256Hex(html) },
          { run: `curl -s $ORD_URL/r/metadata/${PH.parent} | jq -r .`, expect: Buffer.from(cbor).toString('hex') },
          { run: `curl -s $ORD_URL/r/inscription/${PH.parent} | jq '{content_type, content_length}'`, expect: { content_type: 'text/html;charset=utf-8', content_length: html.length } },
        ],
      },
      {
        id: 'gallery',
        who: 'owner',
        run: `node <REPO_ROOT>/products/degent/services/mint/scripts/prepare-gallery.mjs --network ${network} --fee-rate ${feeRate} --parent ${shq(PH.parent)} --signing-address ${shq(PH.signer)} --out <GALLERY_OUT>`,
        expect: 'the Gallery plan (its own plan.json); inscribe it BEFORE the handoff: ord --parent needs the parent in this wallet',
      },
      {
        id: 'parent.handoff',
        who: 'owner',
        after: ['gallery'],
        run: ordSendCommand({ network, feeRate, address: collectionAddress, inscription: PH.parent }),
        expect: 'a txid; after 1 confirmation the parent sits alone at COLLECTION_ADDRESS',
        verify: [
          { run: `curl -s $ORD_URL/r/inscription/${PH.parent} | jq -r .satpoint`, expect: '<send txid>:<vout>:0 (offset 0)' },
          { run: `curl -s -H 'Accept: application/json' $ORD_URL/output/<send txid>:<vout> | jq -r .address`, expect: collectionAddress },
        ],
      },
      {
        id: 'service.env',
        who: 'owner',
        run: null,
        expect: 'set the env below and restart degent-mint; startup refuses a COLLECTION_ADDRESS that is not the signer address and a PARENT_OUTPOINT not held by it',
        verify: [
          { run: 'curl -s $MINT_URL/v1/health | jq .checks.parent', expect: { ok: true, detail: 'confirmed' } },
          { run: 'curl -s $MINT_URL/v1/register | jq .parent', expect: PH.parent },
        ],
      },
    ],
    env: {
      PARENT_INSCRIPTION_ID: { from: 'parent.inscribe', how: 'inscriptions[0].id' },
      PARENT_OUTPOINT: { from: 'parent.handoff', how: '<txid>:<vout> of the parent satpoint after the send (offset must be 0)' },
      COLLECTION_ADDRESS: { value: collectionAddress, how: 'the policy signer address (pnpm --filter @bsh/degent-mint chain-setup collection-address, SIGNER=memory)' },
    },
  };
  return { files, plan };
}

/**
 * The Gallery: gallery.json (REGISTER.md §1.2), its SHA-256 and the BIP-322 message; with `signature`, also the CBOR
 * metadata and the `ord wallet inscribe --parent` command. Two passes because the metadata must carry the
 * signature and inscription metadata is immutable.
 */
export function prepareGallery(opts) {
  const network = requireNetwork(opts.network);
  const feeRate = requireFeeRate(opts.feeRate);
  const postage = requirePostage(opts.postage);
  if (!isInscriptionId(opts.parent)) throw new Error('--parent must be the Club parent inscription id (<txid>i<n>)');
  const signingAddress = opts.signingAddress;
  if (typeof signingAddress !== 'string' || !/^(bc|tb|bcrt)1[02-9ac-hj-np-z]{20,}$/.test(signingAddress))
    throw new Error('--signing-address must be the announced bech32 (p2tr or p2wpkh) signing address');
  const destination = opts.destination || PH.ordWallet;
  const count = opts.count === undefined ? GALLERY_SIZE : Number(opts.count);

  const gallery = buildGallery(opts.roster, count);
  const content = galleryBytes(gallery);
  const sha = sha256Hex(content);
  const message = galleryMessage(sha, opts.parent, count);
  const files = {
    'gallery.json': content,
    'gallery.sha256': utf8(`${sha}  gallery.json\n`),
    'gallery.message.txt': utf8(message),
  };
  const limits = [check('gallery.json bytes', content.length, MAX_GALLERY_BYTES)];

  const signature = typeof opts.signature === 'string' && opts.signature.length > 0 ? opts.signature : null;
  if (signature !== null && !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error('--signature must be base64 (BIP-322 simple)');
  let cbor = null;
  if (signature) {
    const meta = galleryMetadata({ parent: opts.parent, sha256: sha, count, signingAddress, signature });
    cbor = encodeCbor(meta);
    files['gallery.metadata.cbor'] = cbor;
    files['gallery.metadata.json'] = utf8(`${JSON.stringify(meta, null, 2)}\n`);
    limits.push(check('gallery.metadata.cbor bytes', cbor.length, MAX_METADATA_BYTES));
  }
  const bad = limits.filter((l) => !l.ok);
  if (bad.length) throw new Error(`size limits exceeded: ${bad.map((l) => `${l.name} ${l.value} > ${l.max}`).join('; ')}`);

  const inscribe = ordInscribeCommand({
    network,
    feeRate,
    postage,
    parent: opts.parent,
    file: 'gallery.json',
    cborMetadata: 'gallery.metadata.cbor',
    destination,
  });
  const rerun = [
    'node <REPO_ROOT>/products/degent/services/mint/scripts/prepare-gallery.mjs',
    `--network ${network} --fee-rate ${feeRate} --parent ${opts.parent} --signing-address ${signingAddress}`,
    postage !== DEFAULT_POSTAGE_SATS ? `--postage ${postage}` : '',
    opts.destination ? `--destination ${shq(opts.destination)}` : '',
    opts.rosterPath ? `--roster ${shq(opts.rosterPath)}` : '',
    '--signature <BASE64_SIGNATURE> --out "$PWD"',
  ]
    .filter(Boolean)
    .join(' ');
  const steps = [
    {
      id: 'gallery.sign',
      who: 'owner',
      run: null,
      expect: `BIP-322 simple signature (base64) by ${signingAddress} over the exact bytes of gallery.message.txt (no trailing newline)`,
      message,
      done: signature !== null,
    },
    { id: 'gallery.metadata', who: 'owner', run: rerun, expect: 'gallery.metadata.cbor + gallery.metadata.json written', done: signature !== null },
    {
      id: 'gallery.verify-signature',
      who: 'owner',
      run: `pnpm -C <REPO_ROOT> --filter @bsh/degent-mint chain-setup verify-gallery --network ${network} --dir "$PWD"`,
      expect: 'ok: sha256, message and BIP-322 signature match',
    },
    { id: 'gallery.dry-run', who: 'owner', run: `${inscribe} --dry-run`, expect: 'JSON with fees; nothing is broadcast; the parent must be in this ord wallet' },
    {
      id: 'gallery.inscribe',
      who: 'owner',
      run: inscribe,
      expect: 'JSON {commit, reveal, parents:[PARENT], inscriptions:[{id}]}; GALLERY_INSCRIPTION_ID = inscriptions[0].id',
      verify: [
        { run: `curl -s $ORD_URL/content/${PH.gallery} | sha256sum`, expect: sha },
        { run: `curl -s -H 'Accept: application/json' $ORD_URL/inscription/${PH.gallery} | jq -r '.parents[]'`, expect: opts.parent },
        { run: `curl -s $ORD_URL/r/children/${opts.parent} | jq -r '.ids[]'`, expect: `includes ${PH.gallery}` },
        { run: `curl -s $ORD_URL/r/metadata/${PH.gallery} | jq -r .`, expect: cbor ? Buffer.from(cbor).toString('hex') : 'hex of gallery.metadata.cbor' },
        { run: `curl -s $ORD_URL/content/${PH.gallery} | jq '.members | length, (map(.id) | unique | length)'`, expect: [count, count] },
      ],
    },
    {
      id: 'service.env',
      who: 'owner',
      run: null,
      expect: 'set GALLERY_INSCRIPTION_ID and restart; then hand the parent to COLLECTION_ADDRESS (parent plan step parent.handoff)',
      verify: [{ run: 'curl -s $MINT_URL/v1/register | jq .gallery', expect: PH.gallery }],
    },
  ];
  const plan = {
    version: 1,
    kind: 'degent.club/chain-setup/gallery',
    network,
    cwd: 'the --out directory (commands use bare file names)',
    inputs: { parent: opts.parent, signingAddress, count, feeRate, postageSats: postage, destination, signature: signature !== null },
    gallery: { count, sha256: sha, bytes: content.length, message },
    files: Object.entries(files).map(([path, bytes]) => fileEntry(path, bytes)),
    limits,
    fees: 'the dry-run step prints the exact commit and reveal fees (ord computes them; nothing here re-derives weight)',
    next: signature ? 'gallery.verify-signature' : 'gallery.sign',
    steps,
    env: { GALLERY_INSCRIPTION_ID: { from: 'gallery.inscribe', how: 'inscriptions[0].id' } },
  };
  return { files, plan };
}
