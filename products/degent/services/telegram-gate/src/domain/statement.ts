/**
 * The SIWB statements the gate asks wallets to sign. The Telegram user id is part of the signed text, so a
 * signature proves "the holder of this address wants THIS Telegram account in the group" and cannot be replayed
 * for another account (the server rebuilds the statement from the link token and requires an exact match).
 */
export function gateStatement(telegramUserId: number): string {
  return `Prove I hold a Degent to join the degent.club holders group as Telegram user ${telegramUserId}. No transaction, no fees.`;
}

export const ADMIN_STATEMENT = 'Sign in to the degent.club Telegram gate as an operator. No transaction, no fees.';

/** The Telegram user id a gate statement names, or null if the text is not a gate statement. */
export function telegramIdOfStatement(statement: string): number | null {
  const m = /^Prove I hold a Degent to join the degent\.club holders group as Telegram user ([1-9][0-9]{0,15})\. No transaction, no fees\.$/.exec(statement);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
