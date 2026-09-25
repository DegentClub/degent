#!/usr/bin/env node
// Tiny production static file server for @bsh/degent-web's `vite build` output.
// No dependencies beyond Node's stdlib: keeps the runtime image to node:22-slim
// with nothing installed beyond the app's own dist/ assets.
//
// Env:
//   PORT        listen port (default 8080)
//   HOST        listen address (default 0.0.0.0)
//   ROOT_DIR    static root (default /app/dist, the vite build output)
//
// Behaviour: serves files from ROOT_DIR with basic content-type + long-cache headers
// for hashed assets, and falls back to index.html for any GET that doesn't match a
// file (SPA-style deep links), matching the assumption vite's own `preview` makes.
// GET /healthz always returns 200 without touching disk, for container healthchecks.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const ROOT_DIR = process.env.ROOT_DIR ?? '/app/dist';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const normalized = normalize(join(sep, decoded)); // collapses ../ traversal to root
  return join(root, normalized);
}

async function serveFile(res, filePath) {
  const body = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();
  const immutable = /[.-][a-f0-9]{8,}\.(js|css|mjs|woff2?)$/i.test(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const requested = safeJoin(ROOT_DIR, req.url ?? '/');
    let target = requested;
    try {
      const s = await stat(target);
      if (s.isDirectory()) target = join(target, 'index.html');
    } catch {
      target = join(ROOT_DIR, 'index.html'); // SPA fallback
    }

    await serveFile(res, target);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ msg: 'degent-web static server listening', host: HOST, port: PORT, root: ROOT_DIR }));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
