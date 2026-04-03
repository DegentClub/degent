const { collectMetrics } = require('../../metrics-tracker');
const logger = require('../../../lib/logger');

async function handleFetchMetrics(job) {
  logger.info('Starting metrics collection job');
  const result = await collectMetrics();
  return result;
}

module.exports = { handleFetchMetrics };
