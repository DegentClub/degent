// BullMQ scheduler + worker for the 6-hourly re-verification.

const { Queue, Worker } = require('bullmq');

const QUEUE_NAME = 'gate-reverify';

async function startReverifyWorker({ connection, service, everyMs, logger }) {
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler('gate-reverify-recurring', { every: everyMs }, { name: 'reverify-all' });

  const worker = new Worker(QUEUE_NAME, async () => {
    const result = await service.reverifyAll();
    logger.info({
      checked: result.checked,
      kept: result.kept.length,
      kicked: result.kicked.length,
      errors: result.errors.length,
    }, 'gate: re-verification run complete');
    return result;
  }, { connection, concurrency: 1 });

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'gate: re-verification job failed'));

  return {
    queue,
    worker,
    triggerNow: () => queue.add('reverify-now', {}),
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}

module.exports = { startReverifyWorker, QUEUE_NAME };
