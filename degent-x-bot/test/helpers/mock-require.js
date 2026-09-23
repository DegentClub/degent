// The source tree is CommonJS and loads its dependencies with native
// `require()`, which vitest's `vi.mock` does not intercept. This helper
// pre-seeds Node's require cache so that the module under test picks up the
// mock when it requires the real path.
//
// Usage (before requiring the module under test):
//   mockRequire('../src/services/database', { getDb: () => fakeDb });
//   const { handlePostContent } = require('../src/modules/.../post-content');

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(path.join(here, '..', 'index.js'));

const seeded = new Set();

export function mockRequire(relPathFromTestDir, exports) {
  const id = nodeRequire.resolve(relPathFromTestDir);
  nodeRequire.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  seeded.add(id);
  return exports;
}

export function requireFresh(relPathFromTestDir) {
  const id = nodeRequire.resolve(relPathFromTestDir);
  delete nodeRequire.cache[id];
  return nodeRequire(id);
}

export function clearMockRequires() {
  for (const id of seeded) delete nodeRequire.cache[id];
  seeded.clear();
}

export { nodeRequire };
