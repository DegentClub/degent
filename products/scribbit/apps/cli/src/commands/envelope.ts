import { buildInscriptionScript, LIMITS, sha256Hex } from '@bsh/inscription';
import { helpFor, parseArgs, type FlagSpec } from '../args.js';
import { CONTENT_FLAGS, fmt, GLOBAL_FLAGS, loadContent, parsePubkey, toHex } from '../common.js';
import type { CliIO } from '../io.js';
import type { CommandResult } from './types.js';

export const ENVELOPE_FLAGS: Record<string, FlagSpec> = {
  ...CONTENT_FLAGS,
  pubkey: { type: 'string', arg: '<xonly>', description: 'Reveal x-only public key (default: a zero placeholder; size is unaffected)' },
  hex: { type: 'boolean', description: 'Also print the full script hex' },
  ...GLOBAL_FLAGS,
};

export const ENVELOPE_HELP = helpFor(
  'envelope',
  'summarise the ord envelope tapscript for a file',
  'scribbit envelope <file> [--content-type <mime>] [--parent <id>] [--metadata <file>] [--pubkey <xonly>] [--hex] [--json]',
  ENVELOPE_FLAGS,
);

interface Op {
  offset: number;
  /** Serialized size of the op incl. push prefix. */
  size: number;
  opcode: number;
  data?: Uint8Array;
}

/** Walk a script into ops (data pushes carry their payload). */
export function walkScript(script: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  while (i < script.length) {
    const offset = i;
    const opcode = script[i++]!;
    let len = -1;
    if (opcode === 0x00) len = 0;
    else if (opcode <= 75) len = opcode;
    else if (opcode === 0x4c) len = script[i++]!;
    else if (opcode === 0x4d) {
      len = script[i]! | (script[i + 1]! << 8);
      i += 2;
    }
    if (len >= 0) {
      if (i + len > script.length) throw new Error('truncated push');
      ops.push({ offset, size: i + len - offset, opcode, data: script.subarray(i, i + len) });
      i += len;
    } else ops.push({ offset, size: 1, opcode });
  }
  return ops;
}

const pushName = (op: Op) =>
  op.opcode === 0 ? 'OP_0' : op.opcode <= 75 ? `PUSH${op.opcode}` : op.opcode === 0x4c ? `PUSHDATA1(${op.data!.length})` : `PUSHDATA2(${op.data!.length})`;

const TAG_NAMES: Record<number, string> = { 1: 'content type', 3: 'parent', 5: 'metadata' };

function printable(d: Uint8Array): string {
  const s = new TextDecoder('utf-8', { fatal: false }).decode(d);
  return /^[\x20-\x7e]*$/.test(s) ? JSON.stringify(s) : toHex(d);
}

export async function envelopeCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  const args = parseArgs(argv, ENVELOPE_FLAGS);
  if (args.flags.help) return { help: ENVELOPE_HELP };
  const pubkey = args.flags.pubkey !== undefined ? parsePubkey(args.flags.pubkey) : new Uint8Array(32);
  const { path, content } = await loadContent(io, args, 'envelope');
  const script = buildInscriptionScript(pubkey, content);
  const ops = walkScript(script);

  // Structure: <pubkey> CHECKSIG OP_FALSE OP_IF "ord" (tag value)* OP_0 body* OP_ENDIF
  const lines: Array<{ offset: number; size: number; op: string; note: string }> = [];
  const add = (op: Op, note: string) => lines.push({ offset: op.offset, size: op.size, op: op.data ? pushName(op) : opName(op.opcode), note });
  add(ops[0]!, args.flags.pubkey !== undefined ? 'reveal pubkey' : 'reveal pubkey (placeholder)');
  add(ops[1]!, '');
  add(ops[2]!, 'OP_FALSE');
  add(ops[3]!, '');
  add(ops[4]!, `protocol ${printable(ops[4]!.data!)}`);
  let k = 5;
  const tagCounts: Record<string, number> = {};
  while (k < ops.length && !(ops[k]!.opcode === 0x00 && ops[k]!.data?.length === 0)) {
    const tag = ops[k]!.data![0]!;
    const value = ops[k + 1]!;
    const name = TAG_NAMES[tag] ?? `tag ${tag}`;
    tagCounts[name] = (tagCounts[name] ?? 0) + 1;
    if (tag !== 5 || tagCounts[name] === 1) {
      add(ops[k]!, `tag ${tag} (${name})`);
      add(value, tag === 5 ? `metadata chunk 1 (${value.data!.length} B)` : tag === 3 ? `parent ${content.parentId} (encoded ${toHex(value.data!)})` : printable(value.data!));
    }
    k += 2;
  }
  const bodyTag = ops[k]!;
  add(bodyTag, 'body tag');
  const bodyOps = ops.slice(k + 1, ops.length - 1);
  const endif = ops[ops.length - 1]!;
  const bodyChunks = bodyOps.map((o) => o.data!.length);
  const opcodeHistogram: Record<string, number> = {};
  for (const o of ops) {
    if (!o.data) continue;
    const kind = o.opcode === 0 ? 'OP_0' : o.opcode <= 75 ? 'direct' : o.opcode === 0x4c ? 'PUSHDATA1' : 'PUSHDATA2';
    opcodeHistogram[kind] = (opcodeHistogram[kind] ?? 0) + 1;
  }
  const full = bodyChunks.filter((n) => n === LIMITS.MAX_SCRIPT_ELEMENT_SIZE).length;
  const last = bodyChunks.length ? bodyChunks[bodyChunks.length - 1]! : 0;
  const bodyOffset = bodyOps[0]?.offset ?? endif.offset;
  const bodyBytesOnWire = bodyOps.reduce((s, o) => s + o.size, 0);

  const data = {
    file: path,
    contentType: content.contentType,
    bodyBytes: content.body.length,
    metadataBytes: content.metadata?.length ?? 0,
    parentId: content.parentId ?? null,
    pubkey: toHex(pubkey),
    pubkeyPlaceholder: args.flags.pubkey === undefined,
    scriptBytes: script.length,
    overheadBytes: script.length - content.body.length - (content.metadata?.length ?? 0),
    sha256: sha256Hex(script),
    ops: ops.length,
    pushes: opcodeHistogram,
    body: {
      offset: bodyOffset,
      chunks: bodyChunks.length,
      fullChunks: full,
      lastChunkBytes: last,
      bytesWithPushPrefixes: bodyBytesOnWire,
    },
    layout: [
      ...lines,
      ...(bodyOps.length
        ? [{ offset: bodyOffset, size: bodyBytesOnWire, op: `${bodyChunks.length} push(es)`, note: `body: ${full ? `${full} × 520 B` : ''}${full && full !== bodyChunks.length ? ' + ' : ''}${full !== bodyChunks.length ? `${last} B` : ''}` }]
        : []),
      { offset: endif.offset, size: 1, op: 'OP_ENDIF', note: '' },
    ],
    head: toHex(script.subarray(0, 64)),
    tail: toHex(script.subarray(Math.max(0, script.length - 16))),
    ...(args.flags.hex ? { hex: toHex(script) } : {}),
  };

  const w = String(script.length.toString(16)).length;
  const human = [
    `${path}: ${fmt(script.length)}-byte tapscript (${fmt(content.body.length)} body bytes in ${bodyChunks.length} chunk(s), ${fmt(data.overheadBytes)} bytes overhead)`,
    `sha256 ${data.sha256}`,
    '',
    `${'offset'.padEnd(Math.max(6, w))}  ${'size'.padStart(9)}  ${'op'.padEnd(22)}  note`,
    ...data.layout.map((l) => `${l.offset.toString(16).padStart(Math.max(6, w), '0')}  ${fmt(l.size).padStart(9)}  ${l.op.padEnd(22)}  ${l.note}`),
    '',
    `head  ${data.head}`,
    `tail  ${data.tail}`,
    ...(args.flags.hex ? ['', data.hex!] : []),
  ].join('\n');
  return { data, human };
}

function opName(op: number): string {
  switch (op) {
    case 0x63:
      return 'OP_IF';
    case 0x68:
      return 'OP_ENDIF';
    case 0xac:
      return 'OP_CHECKSIG';
    default:
      return `0x${op.toString(16).padStart(2, '0')}`;
  }
}
