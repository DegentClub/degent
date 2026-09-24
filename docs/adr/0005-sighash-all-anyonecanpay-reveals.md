# ADR-0005: SIGHASH_ALL|ANYONECANPAY reveals; self-rescue by re-signing with K_e

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** club owner, team-degent, platform (DegentClub/scribbit)
- **Components:** `@bsh/inscription` (platform, since scribbit `9298e7f`), `@bsh/degent-mint-sdk`, `@bsh/degent-mint`,
  `@bsh/degent-web`
- **Supersedes:** [ADR-0002](0002-degent-mint-architecture.md) §2 steps 4–5 (reveal signed with
  `SIGHASH_SINGLE|ANYONECANPAY`, K_e discarded) and its "Self-rescue" property (rebroadcast the half-signed reveal).
  ADR-0002 §2 steps 1–3 and 6–7, §3 (policy signer) and everything else stand.
- **Related:** [ADR-0007](0007-member-approval-and-register.md) (the `declined` and `rescue_available` flows use the
  rescue defined here); platform `platform/inscription/README.md` "Security model" and `SPEC.md` "Migration".

## Context

ADR-0002 had the browser sign the commit input of the reveal with `SIGHASH_SINGLE|SIGHASH_ANYONECANPAY` (0x83) over
`[commit] → [child]`. The service later inserted the parent input and the parent return output at index 0, shifting
commit and child to index 1 together; the same signature stayed valid, and the half-signed PSBT *was* the rescue
transaction. That let the browser discard K_e right after signing.

The weakness is what 0x83 does not sign. The signature commits to the commit input and to **the one output at its own
index** — nothing else. Whoever holds the half-signed reveal (the browser, the service, anyone who sees a rescue
broadcast in the mempool) can restructure it before broadcast:

- **Fee skimming:** add outputs at index ≥ 2 that take part of `commitValue − postage`.
- **Inscription re-targeting:** put their own input at index 0 with a value that differs from their output 0. By
  ordinal FIFO that moves the new inscription's sat out of the child output (into an output they control, or into
  fees). The child output still receives its postage, but not the inscription.

The recipient address and postage were safe; the inscription and the fee were not. "Keep the PSBT confidential and
broadcast promptly" was the only mitigation, which is not a property of a non-custodial design.

## Decision

1. **The browser signs the reveal with `SIGHASH_ALL|SIGHASH_ANYONECANPAY` (0x81)** over
   `[commit] → [parent return, child]`:
   - output 0 returns the parent to the **collection address** with **exactly** the parent's value (the parent's
     constant postage; exact, not "≥", so the child inscription lands on the first sat of output 1),
   - output 1 pays the child postage to the recipient recorded on the order.

   ALL covers every output, so nobody holding the PSBT can add, drop, reorder or change an output. ANYONECANPAY still
   leaves the other inputs unsigned, so the service attaches the parent input at index 0 exactly as before
   (`attachParent`, which for 0x81 only asserts that the signed output 0 matches), and the policy signer signs it
   (ADR-0002 §3, unchanged in spirit: `domain/policy.ts` still verifies both signed outputs, the two inputs and the fee
   band). The only freedom left to a PSBT holder is the parent input's outpoint and value, and a parent input whose
   value differs from output 0 is refused by `signParentInput` and by the policy.
2. **Self-rescue is a fresh transaction re-signed with K_e.** A 0x81 reveal cannot be broadcast without the parent
   (output 0 would be unfunded), so the rescue is `buildResignedRescue`: the user's browser signs `[commit] → [child]`
   with K_e (script path of the same tapleaf, SIGHASH_DEFAULT; child gets the postage, the rest of the commit value is
   fee). Therefore **K_e is retained, encrypted, in the browser's recovery bundle**: AES-256-GCM under a key derived
   from a recovery passphrase the user chooses (PBKDF2-SHA256, 600,000 iterations, WebCrypto), bound to the order id.
   The plaintext key is wiped from memory once the bundle is saved and is only decrypted, in the tab, to sign a
   rescue. The server never sees K_e or the passphrase, so the service still holds no key that can move user funds.
3. **0x83 is not used by degent.** The platform keeps `sighash: 'single_anyonecanpay'` and `buildRescueReveal` for one
   release; this product neither builds nor accepts 0x83 reveals (`verifyHalfSignedReveal` runs with its default
   0x81 and the expected parent return).

## Consequences

- **The browser must know the parent return address and the current parent value when it signs.** The binding quote
  (`PUT /v1/orders/{id}/content`) now carries `parentReturnAddress` (the collection address) and `parentValueSats`
  (the value of the parent UTXO the service knows), and `POST /v1/orders/{id}/reveal` verifies the half-signed reveal
  against exactly those values. When the service does not know its parent UTXO yet, the upload is refused with
  `503 upstream_unavailable` before any review runs.
- **The parent UTXO moving is harmless; its value changing is not.** ANYONECANPAY does not sign the parent outpoint,
  and every reveal returns the parent with its value unchanged (policy), so the parent can advance any number of times
  between signing and reveal: **no outpoint reservation is needed**. What the signature does fix is the value. If the
  operator re-initialises the parent with a different value (e.g. after a key rotation) while paid orders are waiting,
  their half-signed reveals can no longer be attached. Implemented: the worker compares the leased parent's value with
  the order's quoted `parentValueSats` before `attachParent`, releases the lease and moves the order to
  `rescue_available` (no retry loop, no parent contention). Not implemented: having the web re-sign against a new
  parent value (it would need a new quote round-trip while K_e is decrypted); the runbook says to drain paid orders
  before changing the parent's value.
- **Rescue needs K_e, the passphrase, and the content bytes.** `GET /v1/orders/{id}/rescue` (for `rescue_available`
  and `declined`) no longer returns a transaction: it returns everything `buildResignedRescue` needs except K_e —
  network, commit outpoint and value, recipient, postage, content type, the exact content bytes, the parent id the
  envelope commits to, the reveal public key, the quoted fee rate, and the rescue's exact weight/vsize/fee. The
  browser checks the content hash and public key, asks for the recovery passphrase, decrypts K_e, signs, broadcasts
  through the wallet or esplora, and wipes the key. If the service is gone, the same rescue is built from the recovery
  bundle (which carries all parameters except the content bytes) plus the artwork file, which the user re-selects and
  the browser checks against the bundle's SHA-256.
- **A lost passphrase (or bundle) means no self-rescue.** The mint's normal path (approval → parent reveal) does not
  need either; only the rescue does. The Pay screen says so before the user signs the funding transaction.
- **The service can no longer "prove rescuable" at submission.** Under 0x83 it rebuilt the rescue from the PSBT; under
  0x81 only K_e can. The service verifies the 0x81 signature over both outputs instead; the re-signed rescue is
  1 WU lighter than the rescue layout and ~400 WU lighter than the quoted parent reveal, so the funded commit always
  covers it at the quoted rate (`buildResignedRescue` is called with that rate and reports the overpay).
- Weight and fee maths are identical for 0x81 and 0x83 (65-byte signature either way), so quotes did not change.
- Recovery bundles are now `version: 2` (encrypted K_e, postage, parent id, fee rate; no half-signed PSBT). Version-1
  bundles from 0x83 orders are no longer recognised by the front end.
