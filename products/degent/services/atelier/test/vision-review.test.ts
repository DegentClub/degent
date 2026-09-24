import { describe, expect, it } from 'vitest';
import { ClaudeVisionReview, VISION_REVIEW_MODEL, type BetaMessagesCreate } from '../src/adapters/claude-vision-review.js';

const msg = (over: Record<string, unknown>) => ({ id: 'm', type: 'message', role: 'assistant', model: VISION_REVIEW_MODEL, content: [], stop_reason: 'end_turn', stop_sequence: null, usage: {}, ...over }) as never;
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('ClaudeVisionReview (optional, injected client: never touches the network)', () => {
  it('sends the image with the collection guidelines, structured output and refusal fallbacks', async () => {
    let params: any;
    const create: BetaMessagesCreate = async (p) => ((params = p), msg({ content: [{ type: 'text', text: '{"approved":true,"reasons":[]}' }] }));
    const r = await new ClaudeVisionReview({ create }).review({ refId: 'j', declaredContentType: 'image/jpeg', bytes: jpegBytes });
    expect(r.approved).toBe(true);
    expect(params.model).toBe('claude-opus-5');
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.system).toMatch(/bow tie/);
    expect(params.messages[0].content[0].source).toMatchObject({ type: 'base64', media_type: 'image/jpeg' });
  });

  it('maps a rejection, a refusal and skips unsupported / oversized images', async () => {
    const reject: BetaMessagesCreate = async () => msg({ content: [{ type: 'text', text: '{"approved":false,"reasons":["no bow tie visible"]}' }] });
    expect((await new ClaudeVisionReview({ create: reject }).review({ refId: 'j', declaredContentType: 'image/jpeg', bytes: jpegBytes })).reasons).toEqual(['no bow tie visible']);
    const refuse: BetaMessagesCreate = async () => msg({ stop_reason: 'refusal' });
    expect((await new ClaudeVisionReview({ create: refuse }).review({ refId: 'j', declaredContentType: 'image/jpeg', bytes: jpegBytes })).approved).toBe(false);
    let called = false;
    const spy: BetaMessagesCreate = async () => ((called = true), msg({}));
    const v = new ClaudeVisionReview({ create: spy });
    expect((await v.review({ refId: 'j', declaredContentType: 'image/avif', bytes: jpegBytes })).checks[0]!.detail).toMatch(/skipped/);
    expect((await v.review({ refId: 'j', declaredContentType: 'image/jpeg', bytes: new Uint8Array(3_800_000) })).checks[0]!.detail).toMatch(/skipped/);
    expect(called).toBe(false);
  });

  it('throws on an unparseable verdict (caller treats it as a dependency failure, not a rejection)', async () => {
    const junk: BetaMessagesCreate = async () => msg({ content: [{ type: 'text', text: 'looks great!' }] });
    await expect(new ClaudeVisionReview({ create: junk }).review({ refId: 'j', declaredContentType: 'image/jpeg', bytes: jpegBytes })).rejects.toThrow(/unparseable/);
  });

  it('is disabled without a key', () => {
    expect(ClaudeVisionReview.fromEnv(undefined)).toBeNull();
    expect(ClaudeVisionReview.fromEnv('')).toBeNull();
  });
});
