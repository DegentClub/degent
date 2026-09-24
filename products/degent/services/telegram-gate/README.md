# @bsh/degent-telegram-gate

The **holders-only Telegram group gate** of the Decentralized Gentlemen Club (roadmap p3.6, ADR-0007 follow-up 4).
A wallet proves it holds a Degent with a Sign-in-with-Bitcoin signature and receives a **single-use invite by DM**;
a periodic re-check removes members whose wallet no longer holds one.

Contract: [`contracts/openapi/degent-telegram-gate.yaml`](../../../../contracts/openapi/degent-telegram-gate.yaml).
Holdings: the mint service's Register, `GET /v1/register/holder/{address}`
([`degent-mint.yaml`](../../../../contracts/openapi/degent-mint.yaml)) through `@bsh/degent-mint-sdk`.
Signatures, nonces, sessions: [`@bsh/identity`](../../../../deps/scribbit/platform/identity/README.md).
The web page: `/verify` in [`@bsh/degent-web`](../../apps/web) (`VITE_GATE_URL` = this service's base URL).

Ported from `Degent-X-Bot/src/telegram-gate` (JS, Fastify + BullMQ + Postgres, `bip322-js`). What changed:

| Legacy | Here | Why |
|---|---|---|
| Custom 5-line message, `bip322-js` | SIWB (`issueChallenge` / `verifySignIn`) with the Telegram id in the statement | One audited implementation (BIP-322 simple + legacy), domain binding, canonical grammar, atomic nonces |
| HS256 JWT link token (`a.b.c`) | 50-char HMAC token, single use (jti) | The `/verify` page only accepts `[A-Za-z0-9_-]{8,128}`; one format, no `alg` field |
| Postgres tables, BullMQ repeatable job | `node:sqlite` (like the mint), in-process timer | One process, no Redis; the same ports take a Postgres adapter later |
| Fastify + admin JWT from the X bot | Hono + SIWB operator session (`ADMIN_ADDRESSES`, EdDSA via `SessionKeyRing`) | No shared password secret with another service |
| `REGISTER_API_URL/api/register/holder` → `{holds}` | Mint Register `/v1/register/holder/{address}` → `{holder, degents}` | The contract that exists (ADR-0007) |

## Flow

```mermaid
sequenceDiagram
    autonumber
    actor U as Holder
    participant B as Gate bot (Telegram DM)
    participant W as degent.club /verify
    participant G as Gate /gate/*
    participant R as Mint Register
    participant T as Telegram API

    U->>B: /verify
    B-->>U: WEB_BASE_URL/verify?tg=<token> (10 min, single use)
    U->>W: opens link, connects wallet
    W->>G: POST /gate/challenge {token, address}
    G-->>W: {message (SIWB, statement names the Telegram id), expiresAt}
    W->>U: wallet signs message (BIP-322)
    W->>G: POST /gate/verify {token, address, message, signature}
    G->>G: statement == gateStatement(tg of token); verifySignIn (domain, address, expiry, signature, nonce once)
    G->>R: GET /v1/register/holder/{address} (fresh; retries)
    G->>T: createChatInviteLink(HOLDERS_CHAT_ID, member_limit=1, 10 min)
    G->>T: sendMessage(tg, invite)
    G-->>W: {ok, degents, message}  (never the invite)
    loop every REVERIFY_INTERVAL_SECONDS (6 h)
        G->>R: holder check for every active member
        alt still holds
            G->>G: update degents
        else sold
            G->>G: revoke (frees wallet and account)
            G->>T: banChatMember + unbanChatMember, DM with the reason
        end
    end
```

## Rules enforced (each has a test)

- **Link**: HMAC token with the Telegram id, 10 minutes, consumed on the first successful verification.
- **Challenge**: SIWB, domain = the web host, statement `Prove I hold a Degent to join the degent.club holders group as
  Telegram user <id>. …`, nonce single use and bound to domain + address, never outlives its link. The statement is
  checked **before** the nonce is consumed, so a mismatched request cannot burn someone's challenge.
- **One wallet ↔ one Telegram account** among active members: refused at `/gate/challenge` (before anyone signs) and
  again at `/gate/verify` (`address_taken`, `telegram_taken`, 409). The same pair may re-verify (lost invite) and gets
  a new invite; revocation frees both sides. The sqlite store backs this with a partial unique index.
- **Invite**: exactly one per successful verification, `member_limit: 1`, 10 minutes, **DM only**.
- **Rate limits**: `/verify` 3 per 10 minutes per Telegram user; POSTs per IP (`RATE_LIMIT_PER_MINUTE`).
- **Register**: 5-minute cache, retries with backoff (500 ms, 1 s, 2 s) on network errors, 5xx and 429; 404/422 mean
  "holds nothing"; verification and re-checks always bypass the cache.
- **Re-check never kicks on a Register error.** A Telegram error while kicking keeps the revocation and retries the
  ban/unban on the next run (`kickPending`).
- **Operators**: `GET /gate/stats` requires a session from `/gate/admin/{challenge,verify}` (SIWB by an address in
  `ADMIN_ADDRESSES`); it stops working as soon as the address leaves the list.

## Ports and adapters

| Port | Adapters | Notes |
|---|---|---|
| `TelegramApi` | `GrammyTelegramApi` (grammY `bot.api`), `MemoryTelegramApi` | Bot command handlers `onStart` / `onVerify` are plain functions |
| `MemberStore` | `SqliteMemberStore`, `MemoryMemberStore` | Also holds used link ids |
| `HolderRegistry` | `MintHolderRegistry` (mint-sdk client), `MemoryHolderRegistry` | |
| `NonceStore` (`@bsh/identity`) | `SqliteNonceStore`, `InMemoryNonceStore` | |

## Environment

`env.schema.json` is authoritative. Required everywhere: `NETWORK`, `WEB_BASE_URL`, `HOLDERS_CHAT_ID`. Required off
regtest: `TELEGRAM_GATE_BOT_TOKEN`, `MINT_API_URL`, `GATE_LINK_SECRET` (≥ 32 chars), `SESSION_KEY` (64 hex),
`DATABASE_PATH`. Optional: `ADMIN_ADDRESSES`, `SIWB_DOMAIN`, `PORT` (8788), `HOST`, `REVERIFY_INTERVAL_SECONDS`
(21600), `HOLDER_CACHE_SECONDS` (300), `RATE_LIMIT_PER_MINUTE` (30), `TRUST_PROXY`, `SESSION_KID`,
`SESSION_TTL_SECONDS`. Secret paths: `services/degent-telegram-gate/{bot-token,link-secret,session-key}`.

## Owner setup

1. **Bot**: @BotFather → `/newbot`; store the token at `services/degent-telegram-gate/bot-token`. Leave privacy mode on
   (the gate only reads DMs). Use a dedicated bot, not the X bot's.
2. **Group**: make the bot an admin of the private holders group with only *Invite users via link* and *Ban users*.
3. **Chat id**: send a message in the group, read `chat.id` from `https://api.telegram.org/bot<token>/getUpdates`
   (negative, e.g. `-1001234567890`) → `HOLDERS_CHAT_ID`.
4. **Close other doors**: revoke the group's public/primary invite link and turn off "approve new members"; the bot's
   single-use links are the only way in. Existing members should run `/verify` once so the re-check covers them.
5. **Secrets**: `GATE_LINK_SECRET=$(openssl rand -hex 32)`, `SESSION_KEY=$(openssl rand -hex 32)`; list operator
   addresses in `ADMIN_ADDRESSES`.
6. **Web**: build `@bsh/degent-web` with `VITE_GATE_URL=https://<gate host>`; set this service's `WEB_BASE_URL` to the
   site origin (the only CORS origin).
7. **Run**: `pnpm --filter @bsh/degent-telegram-gate start`; `curl <host>/gate/health`.

## Privacy

Stored: Telegram user id, the verified address, the Degent numbers at the last check, timestamps, invite count. No
usernames, messages, IPs or signatures (verified and discarded). Nonces and used link ids expire and are purged.

## Development

```bash
pnpm --filter @bsh/degent-telegram-gate dev        # NETWORK=regtest: in-memory everything, nothing sent to Telegram
pnpm --filter @bsh/degent-telegram-gate test       # service, HTTP, contract, stores, registry, config, bot handlers
pnpm --filter @bsh/degent-telegram-gate typecheck
```
