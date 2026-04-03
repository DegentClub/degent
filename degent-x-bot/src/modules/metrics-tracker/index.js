const { collectMetrics } = require('./collector');
const { aggregateDaily } = require('./aggregator');

module.exports = {
  collectMetrics,
  aggregateDaily,
};
