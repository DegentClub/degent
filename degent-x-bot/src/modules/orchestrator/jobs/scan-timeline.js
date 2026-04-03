const { scanTimelines } = require('../../engagement-engine');
const config = require('../../../config');
const logger = require('../../../lib/logger');

async function handleScanTimeline(job) {
  if (!config.features.autoEngageEnabled) {
    logger.info('Auto-engagement disabled, skipping scan');
    return { skipped: true, reason: 'disabled' };
  }

  logger.info('Starting timeline scan job');
  const result = await scanTimelines();
  return result;
}

module.exports = { handleScanTimeline };
