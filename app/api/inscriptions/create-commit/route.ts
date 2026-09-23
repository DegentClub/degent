import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { explainTaprootRequirement, validateMainnetAddress } from '@/lib/address';
import { FEE_MAX, FEE_MIN } from '@/lib/fees';
import { ABSOLUTE_MAX_UPLOAD_BYTES, MAX_FILE_BYTES, MIN_FILE_BYTES } from '@/lib/api';
import { clientIpFromHeaders, ipLimiter, recipientLimiter } from '@/lib/rate-limit';

// The in-memory rate limiter and node:crypto need the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SKRYBIT_API_URL = process.env.SKRYBIT_API_URL ?? 'https://api.skrybit.io';
const UPSTREAM_TIMEOUT_MS = 30_000;

let warnedLegacyEnv = false;

/**
 * Resolve the Skrybit key. `SKRYBIT_API_KEY` is the supported name; the old
 * `NEXT_PUBLIC_AUTH_TOKEN` still works so existing deployments do not break,
 * but its NEXT_PUBLIC_ prefix would ship the key to the browser if it were
 * ever referenced in client code, so we warn once.
 */
function resolveApiKey(): string | null {
  if (process.env.SKRYBIT_API_KEY) return process.env.SKRYBIT_API_KEY;
  if (process.env.NEXT_PUBLIC_AUTH_TOKEN) {
    if (!warnedLegacyEnv) {
      warnedLegacyEnv = true;
      console.warn('[create-commit] NEXT_PUBLIC_AUTH_TOKEN is deprecated; rename it to SKRYBIT_API_KEY.');
    }
    return process.env.NEXT_PUBLIC_AUTH_TOKEN;
  }
  return null;
}

function fail(status: number, error: string, requestId: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, requestId, ...extra }, { status, headers: { 'x-request-id': requestId } });
}

function parseFeeRate(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw.trim())) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < FEE_MIN || value > FEE_MAX) return null;
  return value;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const ip = clientIpFromHeaders(request.headers);

  const ipBudget = ipLimiter.hit(ip);
  if (!ipBudget.allowed) {
    return fail(429, 'Too many requests. Please wait a moment and try again.', requestId, {
      retryAfterMs: ipBudget.retryAfterMs,
    });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > ABSOLUTE_MAX_UPLOAD_BYTES + 16 * 1024) {
    return fail(413, 'Upload too large.', requestId);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail(400, 'Expected multipart/form-data.', requestId);
  }

  const file = formData.get('file');
  const recipientAddress = formData.get('recipient_address');
  const senderAddress = formData.get('sender_address');
  const feeRate = parseFeeRate(formData.get('fee_rate'));

  if (!(file instanceof File) || typeof recipientAddress !== 'string' || typeof senderAddress !== 'string') {
    return fail(400, 'Missing required fields.', requestId);
  }
  if (feeRate === null) {
    return fail(400, `Fee rate must be between ${FEE_MIN} and ${FEE_MAX} sat/vB.`, requestId);
  }

  const recipient = recipientAddress.trim();
  const recipientProblem = explainTaprootRequirement(recipient);
  if (recipientProblem) return fail(400, `Recipient address: ${recipientProblem}`, requestId);

  const sender = senderAddress.trim();
  if (!validateMainnetAddress(sender)) return fail(400, 'Sender address is not a valid mainnet address.', requestId);

  if (!file.type.startsWith('image/')) return fail(400, 'Only image files are accepted.', requestId);
  if (file.size > ABSOLUTE_MAX_UPLOAD_BYTES) return fail(413, 'Upload too large.', requestId);
  if (file.size < MIN_FILE_BYTES || file.size > MAX_FILE_BYTES) {
    return fail(
      400,
      `File size must be between ${Math.round(MIN_FILE_BYTES / 1024)} KB and ${Math.round(MAX_FILE_BYTES / 1024)} KB (got ${Math.round(file.size / 1024)} KB).`,
      requestId
    );
  }

  const recipientBudget = recipientLimiter.hit(recipient);
  if (!recipientBudget.allowed) {
    return fail(429, 'Too many quotes for this address. Please wait a moment.', requestId, {
      retryAfterMs: recipientBudget.retryAfterMs,
    });
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(`[create-commit ${requestId}] SKRYBIT_API_KEY is not configured`);
    return fail(500, 'Inscription service is not configured.', requestId);
  }

  const upstreamForm = new FormData();
  upstreamForm.append('file', file, file.name);
  upstreamForm.append('recipient_address', recipient);
  upstreamForm.append('fee_rate', feeRate.toString());
  upstreamForm.append('sender_address', sender);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${SKRYBIT_API_URL}/inscriptions/create-commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
      signal: controller.signal,
    });

    const text = await upstream.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      // Log the upstream body server-side only; never echo it to the client.
      console.error(`[create-commit ${requestId}] upstream ${upstream.status}: ${text.slice(0, 500)}`);
      const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status >= 500 ? 502 : 400;
      return fail(
        status,
        status === 400 ? 'The inscription service rejected this request.' : 'The inscription service is unavailable.',
        requestId
      );
    }

    const paymentAddress = data?.payment_address;
    const amount = Number.parseInt(String(data?.required_amount_in_sats ?? ''), 10);
    const inscriptionId = data?.inscription_id;

    if (typeof paymentAddress !== 'string' || !validateMainnetAddress(paymentAddress)) {
      console.error(`[create-commit ${requestId}] upstream returned invalid payment_address`);
      return fail(502, 'Invalid response from the inscription service.', requestId);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      console.error(`[create-commit ${requestId}] upstream returned invalid required_amount_in_sats`);
      return fail(502, 'Invalid response from the inscription service.', requestId);
    }

    console.info(`[create-commit ${requestId}] quote ok inscription_id=${String(inscriptionId ?? '')} sats=${amount}`);

    return NextResponse.json(
      {
        payment_address: paymentAddress,
        required_amount_in_sats: String(amount),
        inscription_id: typeof inscriptionId === 'string' ? inscriptionId : String(inscriptionId ?? ''),
        requestId,
      },
      { headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } }
    );
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    console.error(`[create-commit ${requestId}] ${aborted ? 'upstream timeout' : 'upstream error'}:`, err);
    return fail(aborted ? 504 : 502, 'The inscription service did not respond. Please try again.', requestId);
  } finally {
    clearTimeout(timeout);
  }
}
