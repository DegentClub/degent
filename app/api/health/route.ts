import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Liveness probe for the container HEALTHCHECK and any load balancer. */
export function GET() {
  return NextResponse.json({ ok: true, configured: Boolean(process.env.SKRYBIT_API_KEY || process.env.NEXT_PUBLIC_AUTH_TOKEN) });
}
