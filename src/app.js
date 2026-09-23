// Express application factory. Everything injectable so tests can run it
// against an in-memory database and a mocked network.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { loadConfig, publicConfig } from './config.js';
import { openDb, prepareStatements } from './db.js';
import { makeSchemas } from './validation.js';
import { createAuth } from './auth.js';
import { createMempoolClient, createInscriptionIndexer } from './indexer.js';
import { createSettlementWatcher } from './settlement-watcher.js';
import { networkFor } from './psbt/index.js';
import { listingRoutes } from './routes/listings.js';
import { buyRoutes } from './routes/buy.js';

export function createApp(overrides = {}) {
  const config = overrides.config || loadConfig();
  const logger = overrides.logger || console;
  const fetchFn = overrides.fetch || globalThis.fetch;
  const db = overrides.db || openDb(config.dbPath);
  const stmts = prepareStatements(db);
  const schemas = makeSchemas(config);
  const network = networkFor(config.network);
  const mempool = overrides.mempool || createMempoolClient({ baseUrl: config.mempoolApi, fetch: fetchFn });
  const indexer = overrides.indexer || createInscriptionIndexer({ kind: config.indexer, ordApi: config.ordApi, hiroApi: config.hiroApi, fetch: fetchFn });
  const auth = createAuth({ stmts, ttlSec: config.challengeTtlSec });

  const collectionPath = path.join(config.publicDir, 'collection.json');
  const collection = overrides.collection || JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const collectionMap = new Map(collection.map((item) => [item.inscription_id, item]));

  const ctx = { config, logger, db, stmts, schemas, auth, mempool, indexer, network, collection, collectionMap };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', overrides.trustProxy ?? false);

  // ── Security headers ──
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', config.ordApi],
        'frame-src': [config.ordApi],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // we embed ordinals.com previews
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  // ── CORS: only the configured origin, otherwise same-origin only ──
  if (config.corsOrigin) {
    app.use(cors({
      origin: (origin, cb) => cb(null, origin === config.corsOrigin ? origin : false),
      methods: ['GET', 'POST'],
      credentials: false,
    }));
  }

  app.use(express.json({ limit: '512kb' }));

  // ── API ──
  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now(), buysEnabled: config.buysEnabled, network: config.network });
  });
  api.get('/config', (_req, res) => res.json(publicConfig(config)));
  api.get('/collection', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(collection);
  });
  listingRoutes(api, ctx);
  buyRoutes(api, ctx);
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // ── Static site: ONLY public/ is exposed ──
  app.use(express.static(config.publicDir, { index: 'index.html', extensions: ['html'], dotfiles: 'deny' }));

  // ── Errors ──
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    const status = Number(err?.status) || 500;
    if (status >= 500) logger.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message, code: err.code, issues: err.issues });
  });

  const watcher = createSettlementWatcher({
    db, stmts, mempool, indexer, logger,
    intervalMs: config.watcherIntervalMs,
    pendingTimeoutMs: config.pendingTimeoutMs,
  });

  return { app, ...ctx, watcher };
}
