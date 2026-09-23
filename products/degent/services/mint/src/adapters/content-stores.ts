import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isSha256Hex, sha256Hex } from '@bsh/degent-mint-sdk';
import type { ContentStore } from '../ports/content-store.js';

/**
 * Filesystem ContentStore: `<dir>/<aa>/<sha256>`, written via temp file + rename so a reader never
 * sees a partial blob. Reads re-hash and refuse corrupted files.
 */
export class FsContentStore implements ContentStore {
  constructor(private readonly dir: string) {}

  private path(sha: string): string {
    if (!isSha256Hex(sha)) throw new Error('invalid sha256');
    return join(this.dir, sha.slice(0, 2), sha);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    const p = this.path(sha);
    if (await this.has(sha)) return sha;
    await mkdir(join(this.dir, sha.slice(0, 2)), { recursive: true });
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o640 });
    await rename(tmp, p);
    return sha;
  }

  async get(sha: string): Promise<Uint8Array | null> {
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
}
