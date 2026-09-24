/**
 * "Which Degents does this address hold right now?" Production: the mint service's Register
 * (`GET /v1/register/holder/{address}`, contracts/openapi/degent-mint.yaml) through `@bsh/degent-mint-sdk`.
 * An empty array means "holds none"; a thrown error means "could not tell" (never treated as "none").
 */
export interface HolderRegistry {
  getHoldings(address: string, opts?: { fresh?: boolean }): Promise<number[]>;
}
