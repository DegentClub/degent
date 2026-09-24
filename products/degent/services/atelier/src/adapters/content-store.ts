/**
 * Content-addressed blob store: the finalised bytes live under their SHA-256 so the mint front end
 * can fetch `GET /v1/content/{sha256}` and PUT the exact same bytes to the mint. Filesystem layout
 * `<dir>/<aa>/<sha256>`, temp file + rename so a reader never sees a partial blob; reads re-hash.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../compose.js';

export interface ContentStore {
  put(bytes: Uint8Array): Promise<string>;
  get(sha: string): Promise<Uint8Array | null>;
  has(sha: string): Promise<boolean>;
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

export class FsContentStore implements ContentStore {
  constructor(private readonly dir: string) {}
  private path(sha: string): string {
    if (!isSha256Hex(sha)) throw new Error('invalid sha256');
    return join(this.dir, sha.slice(0, 2), sha);
  }
  async put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    if (await this.has(sha)) return sha;
    const p = this.path(sha);
    await mkdir(join(this.dir, sha.slice(0, 2)), { recursive: true });
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o640 });
    await rename(tmp, p);
    return sha;
  }
  async get(sha: string): Promise<Uint8Array | null> {
    if (!isSha256Hex(sha)) return null;
    try {
      const buf = new Uint8Array(await readFile(this.path(sha)));
      if (sha256Hex(buf) !== sha) throw new Error(`content store corruption: ${sha}`);
      return buf;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async has(sha: string): Promise<boolean> {
    if (!isSha256Hex(sha)) return false;
    try {
      await stat(this.path(sha));
      return true;
    } catch {
      return false;
    }
  }
}

export class MemoryContentStore implements ContentStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    this.blobs.set(sha, Uint8Array.from(bytes));
    return sha;
  }
  async get(sha: string): Promise<Uint8Array | null> {
    const b = this.blobs.get(sha);
    return b ? Uint8Array.from(b) : null;
  }
  async has(sha: string): Promise<boolean> {
    return this.blobs.has(sha);
  }
  get size(): number {
    return this.blobs.size;
  }
}
