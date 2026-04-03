const fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
const config = require('../config');
const logger = require('../lib/logger');

// Route handlers
const contentRoutes = require('./routes/content');
const engagementRoutes = require('./routes/engagement');
const metricsRoutes = require('./routes/metrics');
const systemRoutes = require('./routes/system');

async function buildServer() {
  const app = fastify({
    logger: false, // We use our own pino logger
  });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.admin.jwtSecret });

  // Auth decorator
  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Login route (no auth required)
  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body || {};
    if (username === config.admin.username && password === config.admin.password) {
      const token = app.jwt.sign({ username, role: 'admin' }, { expiresIn: '24h' });
      return { token };
    }
    reply.code(401).send({ error: 'Invalid credentials' });
  });

  // Register routes
  await app.register(contentRoutes, { prefix: '/api/content' });
  await app.register(engagementRoutes, { prefix: '/api/engagement' });
  await app.register(metricsRoutes, { prefix: '/api/metrics' });
  await app.register(systemRoutes, { prefix: '/api' });

  return app;
}

module.exports = { buildServer };
