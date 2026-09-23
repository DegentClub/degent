import type { MiddlewareHandler } from 'hono';
import { errorResponse } from './context.js';

/**
 * Reject request bodies larger than `maxBytes` with 413 before the handler reads them. A declared
 * Content-Length is checked up front; chunked / undeclared bodies are counted while streaming and
 * buffered (at most `maxBytes`) so the handler can still read them.
 */
export function bodyLimit(maxBytes: number): MiddlewareHandler {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('bodyLimit: maxBytes must be a non-negative integer');
  const tooLarge = `Request body exceeds ${maxBytes} bytes`;
  return async (c, next) => {
    const raw = c.req.raw;
    const cl = raw.headers.get('Content-Length');
    const te = raw.headers.get('Transfer-Encoding');
    if (cl !== null && te === null) {
      if (!/^\d{1,15}$/.test(cl.trim())) return errorResponse(c, 400, 'bad_request', 'Invalid Content-Length');
      if (Number(cl) > maxBytes) return errorResponse(c, 413, 'payload_too_large', tooLarge);
    }
    if (!raw.body) return next();
    if (cl !== null && te === null) return next(); // the runtime enforces the declared length
    const reader = raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return errorResponse(c, 413, 'payload_too_large', tooLarge);
      }
      chunks.push(value);
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ch of chunks) controller.enqueue(ch);
        controller.close();
      },
    });
    c.req.raw = new Request(raw, { body, duplex: 'half' } as RequestInit);
    await next();
  };
}
