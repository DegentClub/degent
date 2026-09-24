/**
 * DGT-SEC-008: mint backups are private files and, when a recipient is configured (required on mainnet),
 * encrypted at rest. The database holds recipient addresses, notification e-mail addresses and Telegram chat
 * ids, votes and the (AES-GCM encrypted) half-signed reveals; backups leave the host.
 *
 * backup.sh runs for real here, with a stand-in `sqlite3` on PATH (the CI image has no sqlite3 CLI
 * guarantee) and the real `age` when installed, else a stand-in that records its arguments.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const root = new URL('..', import.meta.url).pathname;
const deploy = (p: string) => readFileSync(join(root, 'products/degent/deploy', p), 'utf8');
const script = join(root, 'products/degent/deploy/backup.sh');
const hasRealAge = spawnSync('age', ['--version']).status === 0 && spawnSync('age-keygen', ['--help']).status !== null;

/** A sandbox: data dir with a "database", a backup dir, and a bin dir with stand-in tools. */
function sandbox(opts: { fakeAge?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'degent-backup-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'data', 'content', 'ab'), { recursive: true });
  writeFileSync(join(dir, 'data', 'mint.db'), 'SQLITE-DB-BYTES recipient=bc1pexample email=user@example.com\n');
  writeFileSync(join(dir, 'data', 'content', 'ab', 'ab'.repeat(32)), 'artwork');
  // sqlite3 <db> [.timeout n] ".backup 'path'" | 'PRAGMA integrity_check;' | 'SELECT count(*) FROM orders;'
  writeFileSync(
    join(bin, 'sqlite3'),
    `#!/bin/sh
db="$1"; shift
for a in "$@"; do
  case "$a" in
    .backup*) out=$(printf '%s' "$a" | sed "s/^.backup '\\(.*\\)'$/\\1/"); cat "$db" > "$out" ;;
    PRAGMA*) echo ok ;;
    SELECT*) echo 3 ;;
  esac
done
`,
  );
  chmodSync(join(bin, 'sqlite3'), 0o755);
  if (opts.fakeAge) {
    writeFileSync(
      join(bin, 'age'),
      `#!/bin/sh
echo "$@" >> "${join(dir, 'age-args')}"
out=/dev/stdout
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
cat >/dev/null
printf 'age-encryption.org/v1 (stand-in)\\n' > "$out"
`,
    );
    chmodSync(join(bin, 'age'), 0o755);
  }
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${process.env.PATH}`,
    DATABASE_PATH: join(dir, 'data', 'mint.db'),
    CONTENT_DIR: join(dir, 'data', 'content'),
    BACKUP_DIR: join(dir, 'backups'),
    ...extra,
  });
  const run = (extra: Record<string, string> = {}, args: string[] = []) => execFileSync('/bin/sh', [script, ...args], { env: env(extra), encoding: 'utf8' });
  return { dir, run, env };
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe('DGT-SEC-008: mint backups', () => {
  it('writes snapshots, blobs and directories readable by the backup user only (umask 077)', () => {
    const s = sandbox();
    s.run();
    const out = join(s.dir, 'backups');
    const snaps = readdirSync(out).filter((f) => f.startsWith('mint-'));
    expect(snaps).toHaveLength(1);
    expect(mode(join(out, snaps[0]!))).toBe(0o600);
    expect(mode(join(out, 'content'))).toBe(0o700);
    expect(mode(join(out, 'content', 'ab', 'ab'.repeat(32)))).toBe(0o600);
  });

  it('with BACKUP_AGE_RECIPIENT set, the snapshot is age-encrypted and no plaintext copy is left behind', () => {
    const s = sandbox({ fakeAge: true });
    s.run({ BACKUP_AGE_RECIPIENT: 'age1examplerecipient000000000000000000000000000000000000000000' });
    const out = join(s.dir, 'backups');
    const files = readdirSync(out);
    const snaps = files.filter((f) => f.startsWith('mint-'));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatch(/^mint-\d{8}T\d{6}Z\.db\.gz\.age$/);
    expect(files.filter((f) => f.startsWith('.mint-'))).toEqual([]);
    expect(readFileSync(join(out, snaps[0]!), 'utf8')).toMatch(/^age-encryption\.org\/v1/);
    expect(readFileSync(join(s.dir, 'age-args'), 'utf8')).toMatch(/-r age1examplerecipient/);
    expect(mode(join(out, snaps[0]!))).toBe(0o600);
    // --check counts encrypted snapshots too.
    expect(s.run({ BACKUP_AGE_RECIPIENT: 'x' }, ['--check'])).toMatch(/^ok: /);
  });

  it.runIf(hasRealAge)('an encrypted snapshot restores with the matching identity (real age)', () => {
    const s = sandbox();
    const idFile = join(s.dir, 'identity.txt');
    execFileSync('age-keygen', ['-o', idFile], { stdio: 'ignore' });
    const recipient = /public key: (age1\w+)/.exec(readFileSync(idFile, 'utf8'))![1]!;
    s.run({ BACKUP_AGE_RECIPIENT: recipient });
    const snap = readdirSync(join(s.dir, 'backups')).find((f) => f.endsWith('.age'))!;
    const raw = readFileSync(join(s.dir, 'backups', snap));
    expect(raw.includes(Buffer.from('user@example.com'))).toBe(false);
    const target = join(s.dir, 'restored.db');
    s.run({ BACKUP_AGE_IDENTITY: idFile }, ['--restore', join(s.dir, 'backups', snap), target]);
    expect(readFileSync(target, 'utf8')).toContain('user@example.com');
    expect(mode(target)).toBe(0o600);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('mainnet compose requires a backup recipient; the backup image and the NixOS module can encrypt', () => {
    const mainnet = load(deploy('compose.mainnet.yaml')) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(mainnet.services['mint-backup']!.environment!.BACKUP_AGE_RECIPIENT).toMatch(/^\$\{BACKUP_AGE_RECIPIENT:\?/);
    const signet = load(deploy('compose.signet.yaml')) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(signet.services['mint-backup']!.environment!.BACKUP_AGE_RECIPIENT).toBe('${BACKUP_AGE_RECIPIENT:-}');
    expect(deploy('mint.Dockerfile')).toMatch(/apk add --no-cache sqlite age/);
    const nix = deploy('nix/mint.nix');
    expect(nix).toMatch(/ageRecipient = mkOption/);
    expect(nix).toMatch(/BACKUP_AGE_RECIPIENT = /);
    expect(deploy('nix/packages.nix')).toMatch(/pkgs\.age/);
  });

  it('the mint process creates its database and blobs private (umask 077), like the NixOS unit', () => {
    expect(readFileSync(join(root, 'products/degent/services/mint/src/main.ts'), 'utf8')).toMatch(/process\.umask\(0o077\)/);
    expect(deploy('nix/mint.nix')).toMatch(/UMask = "0077"/);
  });
});
