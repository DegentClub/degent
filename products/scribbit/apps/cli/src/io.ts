import type { FetchLike } from '@bsh/fee-oracle';

/** Every side effect the CLI performs goes through this port, so tests run it in-process. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): Promise<Uint8Array>;
  /** Read all of stdin (used by `--psbt -`). */
  readStdin(): Promise<string>;
  fetch: FetchLike;
  env: Record<string, string | undefined>;
}

export async function nodeIO(): Promise<CliIO> {
  const { readFile } = await import('node:fs/promises');
  return {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    readFile: async (p) => new Uint8Array(await readFile(p)),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    fetch: (url, init) => globalThis.fetch(url, init),
    env: process.env,
  };
}
