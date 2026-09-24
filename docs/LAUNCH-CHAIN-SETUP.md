# Launch chain setup — the Club parent and the Gallery

What has to exist on chain before the mint can link a single child to the club, who does it, and how to rehearse it
on signet first. The structures are specified in [REGISTER.md](REGISTER.md) §1.1–1.2; custody in §3; the signer in
[ADR-0002](adr/0002-degent-mint-architecture.md) §3.

**The owner signs; the repository prepares.** Every key operation below (the parent signing key, the ord wallet, the
Gallery signature) is done by the owner on the owner's machines. The scripts are pure: no network, no keys, same
inputs → same bytes. Each writes a machine-readable `plan.json` (steps, exact commands, expected outputs,
verification commands, env to set) next to the files it prepares.

| Script | Produces |
|---|---|
| `products/degent/services/mint/scripts/prepare-parent.mjs` | `charter.html` (< 2 KB, link-free), `parent.metadata.cbor` (+ `.json`), `plan.json` |
| `products/degent/services/mint/scripts/prepare-gallery.mjs` | `gallery.json` (4,112 `{n,id}` from `data/roster.json`), `gallery.sha256`, `gallery.message.txt`; with `--signature` also `gallery.metadata.cbor` (+ `.json`); `plan.json` |
| `pnpm --filter @bsh/degent-mint chain-setup collection-address` | `COLLECTION_ADDRESS` for a `SIGNER=memory` key (signet/testnet) |
| `pnpm --filter @bsh/degent-mint chain-setup verify-gallery` | re-hashes the Gallery and verifies the BIP-322 signature with `@bsh/identity` |

Metadata files are CBOR, so the commands use ord's `--cbor-metadata <file>` (ord's `--metadata` takes YAML/JSON and
converts it; passing a CBOR file there would fail).

## Order of operations (and why)

```
1 parent key ──► COLLECTION_ADDRESS            (owner; KMS on mainnet, key file on signet)
2 inscribe parent ──► owner's ord wallet        (NOT the collection address yet)
3 sign + inscribe Gallery --parent <parent>     (ord needs the parent in the inscribing wallet)
4 send parent ──► COLLECTION_ADDRESS            (the policy signer's address; only it co-signs mint reveals)
5 PARENT_INSCRIPTION_ID, PARENT_OUTPOINT, COLLECTION_ADDRESS, GALLERY_INSCRIPTION_ID ──► degent-mint; restart
```

Inscribing the parent straight to `COLLECTION_ADDRESS` would strand the Gallery: `ord wallet inscribe --parent`
must spend the parent from the ord wallet, and the policy signer only signs transactions that match ADR-0002 §3
(a mint reveal), never an arbitrary Gallery inscription. So the parent goes to the ord wallet first and is handed
to the collection address after the Gallery.

## 0. Prerequisites

- A synced `bitcoind` and an `ord` (≥ 0.18: `--parent`, recursive endpoints) with a funded wallet on the target
  chain; `ORD_URL` = that ord server (used by the verification commands).
- The **announced signing address** for the Gallery: a p2tr or p2wpkh address the club publishes (site, X,
  Telegram) *before* the Gallery is inscribed, from a wallet that signs BIP-322 "simple" messages (Sparrow, UniSat,
  Xverse, Leather, or `ord wallet sign` where available). This key signs one message; keep it cold afterwards.
- A checkout of this repository with `pnpm install` done (`<REPO_ROOT>` below).

## 1. The parent signing key (`COLLECTION_ADDRESS`)

The collection key co-signs input 0 of every mint reveal. Its taproot address is `COLLECTION_ADDRESS`; the service
refuses to start when `COLLECTION_ADDRESS` is not the signer's address.

**Signet / testnet (`SIGNER=memory`, dev only):**

```sh
umask 077; openssl rand -hex 32 > signet-parent.key          # store it like a secret; never commit
pnpm -C <REPO_ROOT> --filter @bsh/degent-mint chain-setup collection-address --network signet --key-file "$PWD/signet-parent.key"
# -> tb1p…   = COLLECTION_ADDRESS
```

Service env: `SIGNER=memory`, `PARENT_KEY_FILE=/run/secrets/signet-parent.key` (secret path
`services/degent-mint/parent-key`), `COLLECTION_ADDRESS=tb1p…`.

**Mainnet (`SIGNER=kms`) — the owner creates the key in the KMS/HSM.** Read
`products/degent/services/mint/src/adapters/kms-policy-signer.ts` first:

- The backend must produce **BIP340 Schnorr** signatures over a 32-byte digest with the **taproot-tweaked** key
  (`tweak = H_TapTweak(P)`, no script tree), and expose the x-only public key for the startup cross-check
  (`SchnorrSigningBackend.publicKey()` / `signDigest()`). ECDSA-only cloud KMS keys cannot do this.
- The private key never leaves the backend; the service only asks for signatures over digests of transactions that
  already passed `evaluateParentPolicy` (ADR-0002 §3), and audit-logs every request.
- **Status: the adapter is not implemented.** `SIGNER` accepts `memory | kms`, but `SIGNER=kms` is refused at
  startup, and mainnet refuses `SIGNER=memory`. Mainnet launch is blocked on the adapter (roadmap p2.16). Its
  backend-specific settings (key id, region, credentials path) are added to `env.schema.json` together with it;
  do not invent them in deployment config before then.
- `COLLECTION_ADDRESS` on mainnet = the p2tr address of the internal key whose tweak the backend signs with; the
  adapter's startup check compares it with `COLLECTION_ADDRESS`.

## 2. Rehearse everything on signet first

Run sections 3–6 end to end on **signet** with a throwaway key file and a throwaway signing address, then mint one
Degent through the signet deployment (upload → pay → members approve → revealed with the parent) and check
`GET /v1/register`. Only when that works, repeat on mainnet with the real keys. Nothing in the scripts differs
between networks except `--network` (and the fee rate).

## 3. Inscribe the Club parent

```sh
node <REPO_ROOT>/products/degent/services/mint/scripts/prepare-parent.mjs \
  --network signet --fee-rate 2 --collection-address <COLLECTION_ADDRESS> \
  --destination <ORD_WALLET_ADDRESS> --out parent-signet
cd parent-signet
ord --chain signet wallet inscribe --fee-rate 2 --postage 10000sat --file charter.html \
  --cbor-metadata parent.metadata.cbor --destination <ORD_WALLET_ADDRESS> --dry-run    # check fees
ord --chain signet wallet inscribe --fee-rate 2 --postage 10000sat --file charter.html \
  --cbor-metadata parent.metadata.cbor --destination <ORD_WALLET_ADDRESS>
```

`PARENT_INSCRIPTION_ID` = `inscriptions[0].id` of the output. Verify (the expected values are in `plan.json`):

```sh
curl -s $ORD_URL/content/<PARENT_INSCRIPTION_ID> | sha256sum      # = sha256 of charter.html
curl -s $ORD_URL/r/metadata/<PARENT_INSCRIPTION_ID> | jq -r .     # = hex of parent.metadata.cbor
```

The parent metadata is `{ name, charter: "10000" }`. REGISTER.md §1.1's `register` pointer is not written: inscription
metadata is immutable and the Gallery does not exist yet; the Gallery is found as the parent's child and is
announced as `GALLERY_INSCRIPTION_ID` (`GET /v1/register` → `gallery`).

## 4. Sign and inscribe the Gallery

Pass 1 — build the Gallery and the message:

```sh
node <REPO_ROOT>/products/degent/services/mint/scripts/prepare-gallery.mjs \
  --network signet --fee-rate 2 --parent <PARENT_INSCRIPTION_ID> \
  --signing-address <SIGNING_ADDRESS> --destination <ORD_WALLET_ADDRESS> --out gallery-signet
```

`gallery.json` is the compact JSON `{"version":1,"members":[{"n":1,"id":"…"},…]}`, the 4,112 roster members ordered
by `n`, unique ids (≈ 348 KB, under the 390,000-byte standard-relay budget). The script refuses gaps, duplicate
numbers and duplicate ids.

Sign **the exact bytes of `gallery.message.txt`** (no trailing newline) with the signing address, BIP-322 simple:

```
degent.club Gallery v1: 4112 members, sha256 <sha256(gallery.json)>, parent <PARENT_INSCRIPTION_ID>
```

Pass 2 — same command plus `--signature <base64>`; writes `gallery.metadata.cbor`
(`{kind:"degent.club/gallery", version:1, parent, count, sha256, message, signer, signature}`). Then:

```sh
cd gallery-signet
pnpm -C <REPO_ROOT> --filter @bsh/degent-mint chain-setup verify-gallery --network signet --dir "$PWD"   # must print ok
ord --chain signet wallet inscribe --fee-rate 2 --postage 10000sat --parent <PARENT_INSCRIPTION_ID> \
  --file gallery.json --cbor-metadata gallery.metadata.cbor --destination <ORD_WALLET_ADDRESS> --dry-run
ord --chain signet wallet inscribe --fee-rate 2 --postage 10000sat --parent <PARENT_INSCRIPTION_ID> \
  --file gallery.json --cbor-metadata gallery.metadata.cbor --destination <ORD_WALLET_ADDRESS>
```

`GALLERY_INSCRIPTION_ID` = `inscriptions[0].id`. Verify:

```sh
curl -s $ORD_URL/content/<GALLERY_INSCRIPTION_ID> | sha256sum                                   # = gallery.sha256
curl -s -H 'Accept: application/json' $ORD_URL/inscription/<GALLERY_INSCRIPTION_ID> | jq -r '.parents[]'   # = parent
curl -s $ORD_URL/r/children/<PARENT_INSCRIPTION_ID> | jq -r '.ids[]'                           # includes the Gallery
curl -s $ORD_URL/content/<GALLERY_INSCRIPTION_ID> | jq '.members | length'                     # 4112
```

If ord stops after the commit (reveal not broadcast), `ord wallet resume` finishes the pending reveal; do not
re-run inscribe, it would pay for a second commit.

## 5. Hand the parent to the collection address

```sh
ord --chain signet wallet send --fee-rate 2 <COLLECTION_ADDRESS> <PARENT_INSCRIPTION_ID>
curl -s $ORD_URL/r/inscription/<PARENT_INSCRIPTION_ID> | jq -r .satpoint     # <txid>:<vout>:0 after 1 confirmation
```

`PARENT_OUTPOINT` = `<txid>:<vout>` of that satpoint. The offset must be 0 and the output must pay
`COLLECTION_ADDRESS` (`initialiseParent` refuses an outpoint the collection key does not hold). The parent's value
(the postage, 10,000 sats) is what every quote signs as output 0 (ADR-0005); do not change it later with paid
orders waiting (RUNBOOK §5).

## 6. Configure degent-mint and verify

| Variable | Value |
|---|---|
| `PARENT_INSCRIPTION_ID` | step 3 |
| `PARENT_OUTPOINT` | step 5 (read only while the store has no parent) |
| `COLLECTION_ADDRESS` | step 1 |
| `GALLERY_INSCRIPTION_ID` | step 4 |
| `SIGNER` / `PARENT_KEY_FILE` | `memory` + key file on signet; `kms` on mainnet (adapter pending) |

```sh
curl -s $MINT_URL/v1/health | jq .checks.parent      # {"ok":true,"detail":"confirmed"}
curl -s $MINT_URL/v1/register | jq '{parent, gallery, count}'
```

Then mint one Degent end to end (signet) and confirm with ord that its reveal lists the parent.

## Mainnet checklist

1. Signet rehearsal done, including one delivered Degent with the parent link.
2. KMS policy signer implemented and deployed; `COLLECTION_ADDRESS` cross-checked at startup.
3. Signing address announced publicly before step 4; the signature verified with `chain-setup verify-gallery`.
4. Fee rate chosen from the mempool at the time (the Gallery reveal is ~350 kB of witness: at 10 sat/vB that is
   on the order of 0.009 BTC; the dry run prints the exact figure).
5. `plan.json` of both runs archived with the transaction ids (they are the provenance of the Register).
