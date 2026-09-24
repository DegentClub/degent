/** Write a prepared { files, plan } into --out (mkdir -p), plan.json last. Shared by the prepare-* scripts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function writeOut(outDir, { files, plan }) {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return dir;
}
