/**
 * "Sign in with Bitcoin" challenge text in the Blockspace ID (SIWB, EIP-4361 style) format that
 * `@bsh/identity` parses and verifies. The site only FORMATS the challenge and asks the wallet to
 * sign it; verification and the nonce store belong to the identity service (`POST /siwb/verify`),
 * because the web app's allowed platform imports (products/degent/CLAUDE.md rule 5) do not include
 * @bsh/identity and a browser cannot keep a trustworthy nonce store anyway.
 */
export interface SiwbParams {
  domain: string;
  address: string;
  network: string;
  nonce: string;
  issuedAt: Date;
  ttlSeconds: number;
  uri?: string;
}

export const SIWB_STATEMENT = 'Sign in with your Bitcoin wallet. This request will not trigger a transaction or cost any fees.';

export function formatSiwb(p: SiwbParams): string {
  const exp = new Date(p.issuedAt.getTime() + p.ttlSeconds * 1000);
  return [
    `${p.domain} wants you to sign in with your Bitcoin account:`,
    p.address,
    '',
    SIWB_STATEMENT,
    '',
    `URI: ${p.uri ?? `https://${p.domain}`}`,
    'Version: 1',
    `Network: ${p.network}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expiration Time: ${exp.toISOString()}`,
  ].join('\n');
}

export function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
