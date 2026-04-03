const { Queue, Worker } = require('bullmq');
const { getRedis } = require('../../services/redis-client');
const logger = require('../../lib/logger');

// Job handlers
const { handlePostContent } = require('./jobs/post-content');
const { handleScanTimeline } = require('./jobs/scan-timeline');
const { handleFetchMetrics } = require('./jobs/fetch-metrics');
const { handleDailyReport } = require('./jobs/daily-report');

const queues = {};
const workers = {};

function getConnection() {
  return getRedis();
}

function setupQueues() {
  const connection = getConnection();

  queues.postContent = new Queue('post-content', { connection });
  queues.scanTimeline = new Queue('scan-timeline', { connection });
  queues.fetchMetrics = new Queue('fetch-metrics', { connection });
  queues.dailyReport = new Queue('daily-report', { connection });
  queues.mentionRespond = new Queue('mention-respond', { connection });

  // Schedule recurring jobs
  // Post content every 2-3 hours
  queues.postContent.upsertJobScheduler('post-content-recurring', {
    every: 150 * 60 * 1000, // 2.5 hours
  }, {
    name: 'generate-and-post',
  });

  // Scan timelines every 30 min
  queues.scanTimeline.upsertJobScheduler('scan-timeline-recurring', {
    every: 30 * 60 * 1000,
  }, {
    name: 'scan-tracked-accounts',
  });

  // Fetch metrics every hour
  queues.fetchMetrics.upsertJobScheduler('fetch-metrics-recurring', {
    every: 60 * 60 * 1000,
  }, {
    name: 'collect-tweet-metrics',
  });

  // Daily report at 11 PM EST (3 AM UTC)
  queues.dailyReport.upsertJobScheduler('daily-report-recurring', {
    pattern: '0 3 * * *', // cron: 3 AM UTC = 11 PM EST
  }, {
    name: 'daily-aggregate',
  });

  // Respond to mentions every 15 min
  queues.mentionRespond.upsertJobScheduler('mention-respond-recurring', {
    every: 15 * 60 * 1000,
  }, {
    name: 'respond-to-mentions',
  });

  logger.info('BullMQ queues and schedulers set up');
  return queues;
}

function startWorkers() {
  const connection = getConnection();

  workers.postContent = new Worker('post-content', handlePostContent, {
    connection,
    concurrency: 1,
  });

  workers.scanTimeline = new Worker('scan-timeline', handleScanTimeline, {
    connection,
    concurrency: 1,
  });

  workers.fetchMetrics = new Worker('fetch-metrics', handleFetchMetrics, {
    connection,
    concurrency: 1,
  });

  workers.dailyReport = new Worker('daily-report', handleDailyReport, {
    connection,
    concurrency: 1,
  });

  workers.mentionRespond = new Worker('mention-respond', async (job) => {
    const { respondToMentions } = require('../engagement-engine/mention-responder');
    return respondToMentions();
  }, {
    connection,
    concurrency: 1,
  });

  // Attach error handlers to all workers
  for (const [name, worker] of Object.entries(workers)) {
    worker.on('completed', (job) => {
      logger.debug({ job: name, jobId: job.id }, 'Job completed');
    });
    worker.on('failed', (job, err) => {
      logger.error({ job: name, jobId: job?.id, err }, 'Job failed');
    });
  }

  logger.info({ workerCount: Object.keys(workers).length }, 'BullMQ workers started');
  return workers;
}

async function stopAll() {
  for (const [name, worker] of Object.entries(workers)) {
    await worker.close();
    logger.info({ worker: name }, 'Worker stopped');
  }
  for (const [name, queue] of Object.entries(queues)) {
    await queue.close();
    logger.info({ queue: name }, 'Queue closed');
  }
}

// Manually trigger a content post (for admin API)
async function triggerPost(contentType) {
  if (!queues.postContent) {
    throw new Error('Queues not initialized');
  }
  const job = await queues.postContent.add('manual-post', { contentType, manual: true });
  return job.id;
}

module.exports = { setupQueues, startWorkers, stopAll, queues, triggerPost };
