import {
  createFeeOracle,
  feeClient,
  mempoolBlocksSource,
  mempoolRecommendedSource,
  publicMempoolUrl,
  type FeeProvider,
  type FeesResponse,
} from '@bsh/scribbit-fee-oracle';
import {
  estimateRevealWeight,
  inscriptionScriptLength,
  laneFor,
  LIMITS,
  quoteReveal,
  type Lane,
  type Network,
} from '@bsh/inscription';
import { failure, helpFor, parseArgs, rejected, usage, type FlagSpec } from '../args.js';
import {
  CONTENT_FLAGS,
  fmt,
  GLOBAL_FLAGS,
  loadContent,
  NETWORK_FLAG,
  parseNetwork,
  parsePositiveNumber,
  parseSats,
  recipientScript,
  table,
} from '../common.js';
import type { CliIO } from '../io.js';
import type { CommandResult } from './types.js';

const TIERS = ['slow', 'normal', 'fast'] as const;
type Tier = (typeof TIERS)[number];

export const QUOTE_FLAGS: Record<string, FlagSpec> = {
  ...CONTENT_FLAGS,
  'fee-rate': { type: 'string', arg: '<sat/vB>', description: 'Use this fee rate (no fee source is contacted)' },
  'fee-source': {
    type: 'string',
    arg: '<url>',
    description: 'Fee source: a scribb.it fee server (URL ending in /v1/fees) or a mempool.space-compatible base URL',
  },
  tier: { type: 'string', arg: '<tier>', description: 'Standard-lane tier: slow | normal | fast (default normal)' },
  network: { ...NETWORK_FLAG, description: 'mainnet | testnet | signet | regtest (default mainnet)' },
  recipient: { type: 'string', arg: '<address>', description: 'Child recipient address (default: a P2TR output is assumed)' },
  postage: { type: 'string', arg: '<sats>', description: `Child output value (default ${LIMITS.DEFAULT_POSTAGE})` },
  ...GLOBAL_FLAGS,
};

export const QUOTE_HELP = helpFor(
  'quote',
  'exact reveal weight, vsize, lane and fees for an inscription',
  'scribbit quote <file> [--parent <id>] [--fee-rate <n> | --fee-source <url>] [--network <net>] [--json]',
  QUOTE_FLAGS,
  [
    'Fee rate: --fee-rate wins; otherwise --fee-source (default: public mempool.space for the network).',
    'Standard-lane reveals use the --tier rate; block-lane reveals use block.recommended.',
    'With --parent the quote is for the parent layout [parent, commit] -> [parent return, child];',
    'the rescue layout (no parent input) is shown too: same fee, 402 WU lighter.',
    'Exit 3 when the reveal is too large for any lane.',
  ].join('\n'),
);

interface LayoutFacts {
  weight: number;
  vsize: number;
  lane: Lane | null;
}

function layout(weight: number): LayoutFacts {
  return { weight, vsize: Math.ceil(weight / 4), lane: laneFor(weight) };
}

/** Which fee provider --fee-source selects. Exported for tests. */
export function feeProviderFor(url: string | undefined, network: Network, io: CliIO): { provider: FeeProvider; kind: string; url: string } {
  const src = url ?? publicMempoolUrl(network);
  if (!src) throw usage(`no public fee source for ${network}; pass --fee-rate <n> or --fee-source <url>`);
  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    throw usage(`invalid --fee-source URL "${src}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw usage(`--fee-source must be http(s): "${src}"`);
  if (/\/v1\/fees\/?$/.test(parsed.pathname))
    return { provider: feeClient({ url: src, network, fetch: io.fetch }), kind: 'scribbit-fee-server', url: src };
  const oracle = createFeeOracle({
    network,
    sources: [mempoolRecommendedSource({ baseUrl: src, fetch: io.fetch }), mempoolBlocksSource({ baseUrl: src, fetch: io.fetch })],
    timeoutMs: 10_000,
  });
  return { provider: oracle, kind: 'mempool', url: src };
}

export async function quoteCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  const args = parseArgs(argv, QUOTE_FLAGS);
  if (args.flags.help) return { help: QUOTE_HELP };
  const network = parseNetwork(args.flags.network, 'mainnet');
  const tierFlag = args.flags.tier as string | undefined;
  if (tierFlag !== undefined && !(TIERS as readonly string[]).includes(tierFlag)) throw usage(`invalid --tier "${tierFlag}" (slow | normal | fast)`);
  const tier = (tierFlag ?? 'normal') as Tier;
  if (args.flags['fee-rate'] !== undefined && args.flags['fee-source'] !== undefined)
    throw usage('--fee-rate and --fee-source are mutually exclusive');
  const explicitRate = args.flags['fee-rate'] !== undefined ? parsePositiveNumber(args.flags['fee-rate'], 'fee-rate') : undefined;
  const postage = args.flags.postage !== undefined ? parseSats(args.flags.postage, 'postage') : LIMITS.DEFAULT_POSTAGE;
  if (postage < LIMITS.DUST_P2TR) throw usage(`--postage ${postage} is below the P2TR dust limit (${LIMITS.DUST_P2TR} sats)`);
  const recipient = recipientScript(args.flags.recipient, network);
  const { path, content, contentTypeInferred } = await loadContent(io, args, 'quote');

  const withParent = content.parentId !== undefined;
  const scriptBytes = inscriptionScriptLength(content);
  const reveal = layout(estimateRevealWeight({ content, withParent, recipientScript: recipient.script }));
  const rescue = withParent ? layout(estimateRevealWeight({ content, withParent: false, recipientScript: recipient.script })) : null;

  const base = {
    file: path,
    network,
    contentType: content.contentType,
    contentTypeInferred,
    bodyBytes: content.body.length,
    metadataBytes: content.metadata?.length ?? 0,
    parentId: content.parentId ?? null,
    recipient: recipient.kind,
    envelope: { scriptBytes, bodyChunks: Math.ceil(content.body.length / LIMITS.MAX_SCRIPT_ELEMENT_SIZE) },
    reveal: { layout: withParent ? 'parent' : 'single', ...reveal },
    rescue,
    limits: { standardMaxWeight: LIMITS.MAX_STANDARD_TX_WEIGHT, blockMaxWeight: LIMITS.BLOCK_LANE_MAX_TX_WEIGHT },
  };
  if (reveal.lane === null)
    throw rejected(
      'too_large',
      `reveal weight ${fmt(reveal.weight)} WU exceeds the block lane limit (${fmt(LIMITS.BLOCK_LANE_MAX_TX_WEIGHT)} WU); ` +
        `shrink the body by at least ${fmt(Math.ceil((reveal.weight - LIMITS.BLOCK_LANE_MAX_TX_WEIGHT)))} bytes`,
      base,
    );

  const warnings: string[] = [];
  let feeRate: number;
  let feeSource: Record<string, unknown>;
  let fees: FeesResponse | null = null;
  if (explicitRate !== undefined) {
    feeRate = explicitRate;
    feeSource = { kind: 'flag' };
    if (feeRate < 1) warnings.push(`fee rate ${feeRate} sat/vB is below the default 1 sat/vB min relay; most nodes will not relay it`);
  } else {
    const { provider, kind, url } = feeProviderFor(args.flags['fee-source'] as string | undefined, network, io);
    try {
      fees = await provider.getFees();
    } catch (e) {
      throw failure('fee_source_failed', `fee source ${url} failed: ${(e as Error).message}`);
    }
    feeRate = reveal.lane === 'block' ? fees.block.recommended : fees.standard[tier];
    feeSource = { kind, url, pick: reveal.lane === 'block' ? 'block.recommended' : `standard.${tier}`, fetchedAt: fees.fetchedAt, stale: fees.stale };
    if (fees.stale) warnings.push('fee data is stale (every upstream refresh failed); double-check before paying');
  }
  if (reveal.lane === 'block')
    warnings.push('block lane: the reveal is non-standard (> 400,000 WU) and needs a Libre Relay / Slipstream broadcaster');

  const q = quoteReveal({ revealWeight: reveal.weight, feeRate, postage });
  const data = {
    ...base,
    feeRate,
    feeSource,
    ...(fees ? { feeMarket: { minFeeRate: fees.minFeeRate, standard: fees.standard, block: fees.block } } : {}),
    fees: {
      revealFee: Number(q.revealFee),
      postage: Number(postage),
      commitValue: Number(q.commitValue),
    },
    ...(rescue ? { rescueEffectiveFeeRate: Math.floor((Number(q.revealFee) / rescue.vsize) * 1000) / 1000 } : {}),
    warnings,
  };

  const rows: Array<[string, string]> = [
    ['file', `${path} (${fmt(content.body.length)} bytes, ${content.contentType}${contentTypeInferred ? ', inferred' : ''})`],
    ['network', network],
    ['parent', content.parentId ?? '-'],
    ['envelope', `${fmt(scriptBytes)} bytes, ${fmt(data.envelope.bodyChunks)} body chunk(s)`],
    ['reveal', `${fmt(reveal.weight)} WU / ${fmt(reveal.vsize)} vB (${data.reveal.layout} layout)`],
    ['lane', `${reveal.lane}${reveal.lane === 'block' ? ' (non-standard)' : ''}`],
  ];
  if (rescue) rows.push(['rescue', `${fmt(rescue.weight)} WU / ${fmt(rescue.vsize)} vB (${rescue.lane}), effective ${data.rescueEffectiveFeeRate} sat/vB`]);
  rows.push(
    ['fee rate', `${feeRate} sat/vB (${feeSource.kind === 'flag' ? '--fee-rate' : `${String(feeSource.pick)} from ${String(feeSource.url)}`})`],
    ['reveal fee', `${fmt(q.revealFee)} sats`],
    ['postage', `${fmt(postage)} sats`],
    ['commit value', `${fmt(q.commitValue)} sats  <- fund the commit address with exactly this`],
  );
  const human = [table(rows), ...warnings.map((w) => `warning: ${w}`)].join('\n');
  return { data, human };
}
