/**
 * Converts the hand-maintained Degent-Marketplace/collection.json into a legacy membership manifest.
 *
 *   tsx src/cli/manifest-from-collection-json.ts <path/to/collection.json> [--collection degent] [--compact]
 *
 * Writes the manifest JSON to stdout, a one-line summary to stderr. Exit codes: 0 ok, 1 invalid
 * input (every problem listed), 2 usage. `--compact` prints the canonical form, i.e. the exact
 * bytes to inscribe (content type application/json) as a child of the collection parent.
 *
 * `size_kb` is rounded and its unit ambiguous, so it is NOT carried over as `contentLength`;
 * sizes are always taken from ord at certification time.
 */
import { readFileSync } from 'node:fs';
import { ManifestError, manifestFromCollectionJson, manifestInscriptionBody, manifestSha256 } from '../domain/manifest.js';

export function run(argv: string[], io: { out: (s: string) => void; err: (s: string) => void; readFile: (p: string) => string }): number {
  let path: string | undefined;
  let collection = 'degent';
  let compact = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--collection') collection = argv[++i] ?? '';
    else if (a === '--compact') compact = true;
    else if (a === '-h' || a === '--help') {
      io.err('usage: manifest-from-collection-json <collection.json> [--collection <slug>] [--compact]\n');
      return 0;
    } else if (a.startsWith('-')) {
      io.err(`unknown option ${a}\n`);
      return 2;
    } else if (path === undefined) path = a;
    else {
      io.err('only one input file is accepted\n');
      return 2;
    }
  }
  if (!path) {
    io.err('usage: manifest-from-collection-json <collection.json> [--collection <slug>] [--compact]\n');
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(io.readFile(path));
  } catch (e) {
    io.err(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  try {
    const r = manifestFromCollectionJson(json, collection);
    io.out((compact ? manifestInscriptionBody(r.manifest) : JSON.stringify(r.manifest, null, 2)) + '\n');
    io.err(`${r.entries} items, collection "${collection}", manifestSha256 ${manifestSha256(r.manifest)} (declared size ${r.declaredSizeKb} kB, informational)\n`);
    return 0;
  } catch (e) {
    if (e instanceof ManifestError) {
      io.err(e.issues.length ? `${e.message.split(':')[0]}:\n${e.issues.map((x) => `  - ${x}`).join('\n')}\n` : `${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    readFile: (p) => readFileSync(p, 'utf8'),
  });
}
