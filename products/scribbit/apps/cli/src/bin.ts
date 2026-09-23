#!/usr/bin/env node
/** Process entry point: `pnpm --filter @bsh/scribbit-cli scribbit <command> ...` or the `scribbit` bin. */
import { run } from './cli.js';
import { nodeIO } from './io.js';

process.exitCode = await run(process.argv.slice(2), await nodeIO());
