// HTTP callbacks for the web verify page, plus the admin stats endpoint.
//
//   POST /gate/challenge  { token, address }                    -> { message, nonce, expires }
//   POST /gate/verify     { token, address, message, signature } -> { ok, degents }
//   GET  /gate/stats      Authorization: Bearer <admin JWT>      -> counts
//   GET  /gate/health

const fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
const { GateError } = require('./service');

async function buildGateServer({ service, config, logger }) {
  const app = fastify({ logger: false, bodyLimit: 16 * 1024 });

  // Only the web app origin may call the browser-facing routes.
  await app.register(cors, { origin: [config.gate.webBaseUrl], methods: ['POST', 'GET'] });
  // Admin JWTs are minted by the main bot's /api/auth/login with the same
  // secret, so an operator needs a single credential.
  await app.register(jwt, { secret: config.admin.jwtSecret });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof GateError || err.name === 'GateError') {
      reply.code(err.status).send({ error: err.code, message: err.message });
      return;
    }
    if (err.validation) {
      reply.code(400).send({ error: 'bad_request', message: err.message });
      return;
    }
    logger.error({ err, url: request.url }, 'gate: unhandled error');
    reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  app.get('/gate/health', async () => ({ status: 'ok' }));

  app.post('/gate/challenge', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'address'],
        properties: {
          token: { type: 'string', maxLength: 2048 },
          address: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request) => service.challenge(request.body));

  app.post('/gate/verify', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'address', 'message', 'signature'],
        properties: {
          token: { type: 'string', maxLength: 2048 },
          address: { type: 'string', maxLength: 100 },
          message: { type: 'string', maxLength: 512 },
          signature: { type: 'string', maxLength: 1024 },
        },
      },
    },
  }, async (request) => {
    const result = await service.verify(request.body);
    // The invite link is delivered by DM only; the web page must not show it.
    return { ok: true, degents: result.degents };
  });

  app.get('/gate/stats', {
    preHandler: async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        reply.code(401).send({ error: 'unauthorized' });
      }
    },
  }, async () => service.stats());

  return app;
}

module.exports = { buildGateServer };
