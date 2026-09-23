import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mocks ---------------------------------------------------------------
// The source is CommonJS; vi.mock does not reach native require(), so the
// dependencies are seeded into the require cache instead (see helpers).
import { mockRequire, requireFresh } from './helpers/mock-require';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() };
mockRequire('../src/lib/logger', logger);

const config = {
  features: { autoPostEnabled: true, reviewQueueEnabled: true },
};
mockRequire('../src/config', config);

const generateTweet = vi.fn();
mockRequire('../src/modules/content-engine', {
  generateTweet: (...a) => generateTweet(...a),
  getContentTypeForTimeSlot: () => 'meme',
});

const postTweet = vi.fn();
const uploadMedia = vi.fn();
mockRequire('../src/services/twitter-client', {
  postTweet: (...a) => postTweet(...a),
  uploadMedia: (...a) => uploadMedia(...a),
});

const canExecute = vi.fn();
const recordUsage = vi.fn();
mockRequire('../src/lib/rate-limiter', {
  canExecute: (...a) => canExecute(...a),
  recordUsage: (...a) => recordUsage(...a),
});

const recordContent = vi.fn();
mockRequire('../src/lib/deduplicator', { recordContent: (...a) => recordContent(...a) });

// Minimal fake drizzle db: records inserts, serves a configurable approved list.
function makeDb() {
  const state = { approved: [], inserted: [], updated: [] };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.approved,
        }),
      }),
    }),
    insert: () => ({
      values: (v) => ({
        returning: async () => {
          const record = { id: `id-${state.inserted.length + 1}`, ...v };
          state.inserted.push(record);
          return [record];
        },
      }),
    }),
    update: () => ({
      set: (v) => ({
        where: async () => {
          state.updated.push(v);
          return [];
        },
      }),
    }),
  };
  return { db, state };
}

let dbState;
mockRequire('../src/services/database', { getDb: () => dbState.db });

const { handlePostContent } = requireFresh('../src/modules/orchestrator/jobs/post-content');

beforeEach(() => {
  vi.clearAllMocks();
  dbState = makeDb();
  config.features.autoPostEnabled = true;
  config.features.reviewQueueEnabled = true;
  canExecute.mockResolvedValue(true);
  postTweet.mockResolvedValue({ id: '123' });
});

const gen = (text) => ({ text, model: 'test-model', prompt: 'p', score: 80 });

// ---- tests ---------------------------------------------------------------

describe('handlePostContent — generated content', () => {
  it('auto tier + REVIEW_QUEUE_ENABLED=true -> inserted pending, not posted', async () => {
    generateTweet.mockResolvedValue(gen('gm, gentlemen. the market awaits.'));
    const result = await handlePostContent({ data: {} });

    expect(dbState.state.inserted).toHaveLength(1);
    expect(dbState.state.inserted[0]).toMatchObject({ approvalTier: 'auto', status: 'pending' });
    expect(postTweet).not.toHaveBeenCalled();
    expect(result).toMatchObject({ queued: true, tier: 'auto', status: 'pending' });
  });

  it('auto tier + REVIEW_QUEUE_ENABLED=false -> inserted approved and posted', async () => {
    config.features.reviewQueueEnabled = false;
    generateTweet.mockResolvedValue(gen('gm, gentlemen. the market awaits.'));
    const result = await handlePostContent({ data: {} });

    expect(dbState.state.inserted[0]).toMatchObject({ approvalTier: 'auto', status: 'approved' });
    expect(postTweet).toHaveBeenCalledWith('gm, gentlemen. the market awaits.', {});
    expect(recordUsage).toHaveBeenCalledWith('POST /tweets');
    expect(recordContent).toHaveBeenCalledWith('123', 'gm, gentlemen. the market awaits.');
    expect(dbState.state.updated[0]).toMatchObject({ status: 'posted', tweetId: '123' });
    expect(result).toEqual({ posted: true, tweetId: '123' });
  });

  it('review tier -> pending even with the queue off, NFA appended', async () => {
    config.features.reviewQueueEnabled = false;
    generateTweet.mockResolvedValue(gen('4,113 of 10,000 minted. 1.5 GB of blockspace and counting.'));
    const result = await handlePostContent({ data: {} });

    expect(dbState.state.inserted[0]).toMatchObject({ approvalTier: 'review', status: 'pending' });
    expect(dbState.state.inserted[0].textContent).toMatch(/NFA\.$/);
    expect(postTweet).not.toHaveBeenCalled();
    expect(result.tier).toBe('review');
  });

  it('manual tier (floor projection) -> pending, never posted, no NFA', async () => {
    config.features.reviewQueueEnabled = false;
    generateTweet.mockResolvedValue(gen('~$12.8M floor at completion. the math does the talking.'));
    const result = await handlePostContent({ data: {} });

    expect(dbState.state.inserted[0]).toMatchObject({ approvalTier: 'manual', status: 'pending' });
    expect(dbState.state.inserted[0].textContent).not.toMatch(/NFA/);
    expect(postTweet).not.toHaveBeenCalled();
    expect(result.tier).toBe('manual');
  });

  it('safety failure (wallet address) -> pending, never posted', async () => {
    config.features.reviewQueueEnabled = false;
    generateTweet.mockResolvedValue(gen('tip jar: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'));
    await handlePostContent({ data: {} });

    expect(dbState.state.inserted[0].status).toBe('pending');
    expect(postTweet).not.toHaveBeenCalled();
  });

  it('skips when auto-posting is disabled', async () => {
    config.features.autoPostEnabled = false;
    const result = await handlePostContent({ data: {} });
    expect(result).toEqual({ skipped: true, reason: 'disabled' });
    expect(generateTweet).not.toHaveBeenCalled();
  });

  it('skips when generation returns nothing', async () => {
    generateTweet.mockResolvedValue(null);
    const result = await handlePostContent({ data: {} });
    expect(result).toEqual({ skipped: true, reason: 'generation_failed' });
    expect(dbState.state.inserted).toHaveLength(0);
  });
});

describe('handlePostContent — approved queue', () => {
  it('posts human-approved content from the queue without generating', async () => {
    dbState.state.approved = [{
      id: 'q1', status: 'approved', approvalTier: 'review', approvedBy: 'admin',
      textContent: 'gentlemen, a partnership.', contentType: 'community', mediaUrls: [],
    }];
    const result = await handlePostContent({ data: {} });

    expect(generateTweet).not.toHaveBeenCalled();
    expect(postTweet).toHaveBeenCalledWith('gentlemen, a partnership.', {});
    expect(result).toEqual({ posted: true, tweetId: '123' });
  });

  it('refuses manual-tier content that has no approver, even if status is approved', async () => {
    dbState.state.approved = [{
      id: 'q2', status: 'approved', approvalTier: 'manual', approvedBy: null,
      textContent: 'floor will 10x', contentType: 'alpha', mediaUrls: [],
    }];
    generateTweet.mockResolvedValue(gen('gm, gentlemen.'));
    await handlePostContent({ data: {} });

    expect(postTweet).not.toHaveBeenCalled(); // queue on -> generated goes pending
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ id: 'q2' }), expect.stringMatching(/refusing/i));
  });

  it('posts manual-tier content once a human approved it', async () => {
    dbState.state.approved = [{
      id: 'q3', status: 'approved', approvalTier: 'manual', approvedBy: 'jeirmeister',
      textContent: 'a word on fees.', contentType: 'alpha', mediaUrls: [],
    }];
    await handlePostContent({ data: {} });
    expect(postTweet).toHaveBeenCalledWith('a word on fees.', {});
  });

  it('re-queues when the tweet rate limit is hit', async () => {
    config.features.reviewQueueEnabled = false;
    canExecute.mockResolvedValue(false);
    generateTweet.mockResolvedValue(gen('gm, gentlemen.'));
    const result = await handlePostContent({ data: {} });
    expect(result).toEqual({ skipped: true, reason: 'rate_limit' });
    expect(postTweet).not.toHaveBeenCalled();
  });

  it('marks the record failed and rethrows when posting fails', async () => {
    dbState.state.approved = [{
      id: 'q4', status: 'approved', approvalTier: 'auto', approvedBy: 'admin',
      textContent: 'gm.', contentType: 'gm', mediaUrls: [],
    }];
    postTweet.mockRejectedValue(new Error('boom'));
    await expect(handlePostContent({ data: {} })).rejects.toThrow('boom');
    expect(dbState.state.updated[0]).toMatchObject({ status: 'failed' });
  });
});
