import { commitAddress, NUMS_INTERNAL_KEY } from '@bsh/inscription';
import { helpFor, parseArgs, type FlagSpec } from '../args.js';
import { CONTENT_FLAGS, fmt, GLOBAL_FLAGS, loadContent, NETWORK_FLAG, parseNetwork, parsePubkey, table, toHex } from '../common.js';
import type { CliIO } from '../io.js';
import type { CommandResult } from './types.js';

export const COMMIT_FLAGS: Record<string, FlagSpec> = {
  ...CONTENT_FLAGS,
  pubkey: { type: 'string', arg: '<xonly>', description: 'Reveal x-only public key (required; the ephemeral K_e public key)' },
  network: { ...NETWORK_FLAG, description: 'mainnet | testnet | signet | regtest (required)' },
  ...GLOBAL_FLAGS,
};

export const COMMIT_HELP = helpFor(
  'commit-address',
  'P2TR commit address (NUMS internal key + inscription leaf) for a file',
  'scribbit commit-address <file> --pubkey <xonly> --network <net> [--parent <id>] [--content-type <mime>] [--json]',
  COMMIT_FLAGS,
  'The address commits to the exact envelope bytes: the same file, content type, parent, metadata and pubkey\n' +
    'must be used when building the reveal, or the commit output cannot be spent by it.',
);

export async function commitAddressCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  const args = parseArgs(argv, COMMIT_FLAGS);
  if (args.flags.help) return { help: COMMIT_HELP };
  const pubkey = parsePubkey(args.flags.pubkey);
  const network = parseNetwork(args.flags.network);
  const { path, content } = await loadContent(io, args, 'commit-address');
  const c = commitAddress(pubkey, content, network);
  const data = {
    file: path,
    network,
    address: c.address,
    scriptPubKey: toHex(c.script),
    internalKey: toHex(NUMS_INTERNAL_KEY),
    pubkey: toHex(pubkey),
    tapLeafHash: toHex(c.tapLeafHash),
    controlBlock: toHex(c.controlBlock),
    leafScriptBytes: c.leafScript.length,
    contentType: content.contentType,
    bodyBytes: content.body.length,
    parentId: content.parentId ?? null,
  };
  const human = table([
    ['address', c.address],
    ['network', network],
    ['scriptPubKey', data.scriptPubKey],
    ['internal key', `${data.internalKey} (BIP341 NUMS, no key path)`],
    ['tapleaf hash', data.tapLeafHash],
    ['control block', data.controlBlock],
    ['leaf script', `${fmt(c.leafScript.length)} bytes (${content.contentType}${content.parentId ? `, parent ${content.parentId}` : ''})`],
  ]);
  return { data, human };
}
