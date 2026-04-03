const { aggregateDaily } = require('../../metrics-tracker');
const logger = require('../../../lib/logger');

async function handleDailyReport(job) {
  logger.info('Starting daily report aggregation');
  const today = new Date().toISOString().split('T')[0];
  const result = await aggregateDaily(today);
  return result;
}

module.exports = { handleDailyReport };
