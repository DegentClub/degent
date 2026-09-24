#!/usr/bin/env node
/**
 * Production bundle: src/main.ts (and everything it imports, workspace packages included) -> dist/main.mjs, and
 * scripts/signet-parent.mjs -> dist/signet-parent.mjs.
 * Workspace packages export TypeScript sources, which Node cannot run from node_modules, so the runtime
 * image ships this single ESM file instead of tsx. Only node: builtins stay external (node:sqlite needs
 * Node >= 22.13). The file sits one level below the service directory, like src/, so the roster path
 * (ROSTER_FILE, relative to the service directory) resolves the same way.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  // main: the service. signet-parent: the test-network parent/member inscriber deploy.sh runs (docs/SERVER.md).
  entryPoints: { main: 'src/main.ts', 'signet-parent': 'scripts/signet-parent.mjs' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'linked',
  external: ['node:*'],
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
