#!/usr/bin/env node
// `scribbit` executable: registers tsx so the TypeScript sources (workspace convention: no build step) run directly.
import { register } from 'tsx/esm/api';

register();
await import('../src/bin.ts');
