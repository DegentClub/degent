/** Every text the bot sends. Kept in one place so tone and facts stay consistent (brand: "the Club", "Degent"). */
export const MESSAGES = {
  start: 'Send /verify to prove you hold a Degent and receive your invite to the holders group.',
  dmOnly: 'DM me /verify — verification happens in private.',
  linkIntro: (url: string, minutes: number) =>
    `Holders only, gentlemen. Sign a message with the wallet that holds your Degent to prove it.\n\n` +
    `Open this link within ${minutes} minutes — it works once:\n${url}\n\n` +
    `Nothing is sent from your wallet. You only sign text.`,
  welcome: (invite: string, count: number, minutes: number) =>
    `Verified. ${count} Degent${count === 1 ? '' : 's'} on record.\n\n` +
    `Your invite (single use, expires in ${minutes} minutes):\n${invite}\n\nWelcome to the Club.`,
  revoked: (address: string) =>
    `Your membership of the holders group was revoked: the wallet you verified (${address}) no longer holds a Degent.\n\n` +
    `If that changes, send /verify again and you can rejoin.`,
  rateLimited: 'Easy, ser. Try /verify again in a few minutes.',
  failed: 'Something went wrong. Try again in a minute.',
  verifiedWeb: 'Verified. Your single-use invite is in your Telegram DMs.',
  verifiedWebNoDm: 'Verified, but the bot could not DM you. Open the bot, press Start, and send /verify again.',
} as const;
