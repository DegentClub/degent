/**
 * The facts a draft may state, read from the mint service's public Register
 * (contracts/openapi/degent-mint.yaml: /v1/register/verify/{id}, /v1/register/{n}, /v1/stats).
 * Production adapter: the typed client from @bsh/degent-mint-sdk.
 */
import type { MintClient } from '@bsh/degent-mint-sdk';

export type RegisterReader = Pick<MintClient, 'registerVerify' | 'registerMember' | 'stats'>;
