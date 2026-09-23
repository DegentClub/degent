# @bsh/wallet-kit

One browser-wallet interface for **UniSat, Xverse, Leather, OKX and Magic Eden**: connect, sign a PSBT,
sign a message, and (where the wallet can) broadcast. Product code never branches on wallet id.

```ts
import { createWalletKit, requireSegwitPayment, UserRejectedError } from '@bsh/wallet-kit';

const kit = createWalletKit({ network: 'signet' });
kit.detect();                                 // adapters injected in this page right now
kit.on('disconnect', ({ id, reason }) => …);  // 'user' | 'replaced' | 'accountsChanged'

const wallet = await kit.connect('xverse');   // throws WalletNotInstalledError / UserRejectedError / UnsupportedNetworkError
requireSegwitPayment(wallet.payment);         // throws UnsupportedAddressTypeError for legacy 1…/m…/n…

const { psbtBase64, txid } = await wallet.signPsbt(fundingPsbtBase64, {
  inputsToSign: [{ index: 0, address: wallet.payment.address }],
  broadcast: true,
});
```

## Surface

| Export | What it does |
|---|---|
| `WalletAdapter` | `{ id, name, installUrl, networks, isInstalled(), connect({ network }) }` |
| `ConnectedWallet` | `{ id, network, ordinals, payment, signPsbt, signMessage, pushTx?, disconnect, onAccountsChanged? }` |
| `ADAPTERS`, `getAdapter(id)`, `detectWallets()` | Registry. `detectWallets` is evaluated on each call: extensions inject late |
| `createWalletKit({ network, adapters? })` | `{ network, adapters, current, detect(), connect(id), disconnect(), on(event, cb) → unsubscribe }` |
| `detectAddressType`, `detectAddressNetwork`, `addressMatchesNetwork`, `requireSegwitPayment` | Address classification (checksum-validated for bech32/bech32m) |
| `psbtBase64ToHex`, `psbtHexToBase64`, `normalizePsbtBase64` | Codec. Checks the `psbt\xff` magic |
| Errors | See below |

**Conventions.** PSBTs are **base64** at the kit boundary; adapters convert to hex where needed. `testnet`
means **testnet4** wherever a wallet can tell them apart. Every `connect` checks that the returned
addresses belong to the requested network (bc1/1/3 vs tb1/m/n/2 vs bcrt1). Testnet and signet share
prefixes, so for those two the kit relies on the wallet's own network selection.

**Safety checks before the wallet is called.** `signPsbt` refuses an empty `inputsToSign`, negative,
fractional or duplicate indexes, an address that is not the connected ordinals/payment address
(`ADDRESS_NOT_IN_WALLET`: this matters for Leather, which signs by index only), and a payload without the
PSBT magic. The signed PSBT a wallet returns is checked the same way.

### Kit events

| Event | Payload | When |
|---|---|---|
| `connect` | `ConnectedWallet` | After a successful `connect(id)` |
| `disconnect` | `{ id, reason }` | `user` (kit or wallet `disconnect()`), `replaced` (another wallet connected), `accountsChanged` |
| `accountsChanged` | `{ id }` | The extension switched account/network. The kit then drops the session: a stale account must never sign |
| `error` | `{ id, error: WalletError }` | `connect(id)` failed (the error is also thrown) |

If two `connect` calls race, the later one wins and the earlier one rejects with `WALLET_ERROR`.

### Errors

All errors extend `WalletError` and carry a stable `code` (never renamed) and `walletId`.

| Class | `code` | Thrown when |
|---|---|---|
| `WalletNotInstalledError` | `WALLET_NOT_INSTALLED` | The provider is not injected |
| `UserRejectedError` | `USER_REJECTED` | The user declined. Mapped from EIP-1193 `4001`, sats-connect `-32000`, `USER_REJECTION`, and "user rejected/denied/cancelled" messages, whether the provider rejects or resolves an error envelope |
| `UnsupportedNetworkError` | `UNSUPPORTED_NETWORK` | The wallet cannot do this network, would not switch, or returned addresses from another network |
| `UnsupportedAddressTypeError` | `UNSUPPORTED_ADDRESS_TYPE` | `requireSegwitPayment` on p2pkh / unknown |
| `WalletError` | `UNSUPPORTED_METHOD`, `UNKNOWN_WALLET`, `INVALID_PSBT`, `INVALID_REQUEST`, `ADDRESS_NOT_IN_WALLET`, `NOT_CONNECTED`, `WALLET_ERROR` | Everything else. The original provider error is kept as `cause` |

### Why `requireSegwitPayment`

ADR-0002 §2 step 3: the browser computes the funding txid from the **unsigned** transaction and pre-signs the
reveal against it before the user signs the funding PSBT. That only works if no funding input carries a
scriptSig, which means segwit or taproot. A legacy p2pkh input changes the txid on signing, so the pre-signed
reveal would be orphaned. The helper rejects `p2pkh` and anything unrecognised. `3…`/`2…` are classed as
`p2sh-p2wpkh`, the only P2SH account type wallets hand out; the address alone cannot prove that.

## Support matrix

"Sighash 0x83" is **not needed from any wallet**. In the degent mint the `SIGHASH_SINGLE|ANYONECANPAY`
signature on the reveal's commit input is made in the browser with the ephemeral key `K_e` (ADR-0002 §2
step 4). The wallet only signs the funding PSBT with its default sighash. `sighashTypes` is forwarded where
a wallet accepts it (column "sighash param") but nothing in the mint relies on it.

| | UniSat | OKX | Xverse | Leather | Magic Eden |
|---|---|---|---|---|---|
| Provider | `window.unisat` | `window.okxwallet.bitcoin` / `.bitcoinTestnet` / `.bitcoinSignet` | `window.XverseProviders.BitcoinProvider` | `window.LeatherProvider` | `window.magicEden.bitcoin` |
| Connect | `requestAccounts` + `getPublicKey` | `connect()` on the network's provider | `wallet_connect` → `getAccounts` → `getAddresses` (falls back only on method-not-found) | `getAddresses` | sats-connect `request` (as Xverse); v1 JWT `connect(token)` fallback |
| Ordinals address | the single account | the single account | `purpose: 'ordinals'` | `type: 'p2tr'` | `purpose: 'ordinals'` |
| Payment address | the same account | the same account | `purpose: 'payment'` | `type: 'p2wpkh'` | `purpose: 'payment'` |
| signPsbt format | hex, `{ autoFinalized, toSignInputs[{index,address,sighashTypes}] }` | hex, same as UniSat | base64, `signInputs: { [address]: index[] }` | hex, `signAtIndex: index[]`, `network`, `allowedSighash` | base64 (request API) / `inputsToSign[{address, signingIndexes, sigHash}]` (v1) |
| Sighash param | yes (`sighashTypes`) | yes (`sighashTypes`) | no (uses the PSBT's own `sighashType`) | yes (`allowedSighash`) | v1 only, one per address |
| Sighash 0x83 from wallet | not needed | not needed | not needed | not needed | not needed |
| `finalize` | yes (`autoFinalized`) | yes | no: finalized only when broadcasting | no: finalized only when broadcasting | no: finalized only when broadcasting |
| Broadcast | `signPsbt` then `pushPsbt`, returns txid | same as UniSat | `broadcast: true`, returns `txid` | `broadcast: true`, returns `txid` | `broadcast: true`, returns `txid` |
| `pushTx(raw)` | `pushTx({ rawtx })` | `pushTx(rawtx)` | none | none | none |
| signMessage BIP-322 | `signMessage(msg, 'bip322-simple')` | same | `signMessage { address, message, protocol: 'BIP322' }` | `signMessage { message, paymentType, network }` | same as Xverse / v1 token |
| signMessage ECDSA | yes | yes | yes (`protocol: 'ECDSA'`) | no, throws `UNSUPPORTED_METHOD` | yes |
| Disconnect | `disconnect()` if present | `disconnect()` if present | `wallet_disconnect` | none (no-op) | `wallet_disconnect` / none (v1) |
| Account-change events | `accountsChanged`, `networkChanged`, `chainChanged` | `accountChanged` | `addListener('accountChange' / 'networkChange')` | none | as Xverse if `addListener` exists |
| Networks | mainnet, testnet(4), signet | mainnet, testnet, signet | mainnet, testnet(4), signet, regtest | mainnet, testnet, signet, regtest | mainnet only |
| Network selection | `getChain`/`switchChain` (`BITCOIN_MAINNET`/`BITCOIN_TESTNET4`/`BITCOIN_SIGNET`), verified after the switch; falls back to `getNetwork`/`switchNetwork` (`livenet`/`testnet`, no signet) | pick the provider | `network` param; reported network checked | whatever the user selected; checked from addresses | `network` param |

## Verified vs assumed

**VERIFIED** means the call shape matches working code in the audited legacy repos
(`skrybit-suite/*/web/src/lib/wallet/`, `backend-core/packages/wallet-connect/`, `counters.fun/apps/web/src/lib/wallet/`,
`degen-minter-3/lib/wallet.ts`). **ASSUMED** means it comes from public wallet documentation or from how the
wallet's family of APIs usually behaves, with no working reference we could read. No wallet in this package
has been tested against a real extension yet. Every ASSUMED row needs a manual check against the live
extension before mainnet launch.

### UniSat

| Detail | Status | Source |
|---|---|---|
| `window.unisat`, `requestAccounts()`, `getPublicKey()` | VERIFIED | ordinals-mint `unisat.ts`, backend-core `adapters/unisat.js`, degen-minter-3 |
| `switchChain('BITCOIN_MAINNET' \| 'BITCOIN_TESTNET4' \| 'BITCOIN_SIGNET')` | VERIFIED | ordinals-mint `unisat.ts` |
| `getChain()` returning `{ enum }` | ASSUMED | UniSat docs; legacy only calls `switchChain` |
| `getNetwork()` / `switchNetwork('livenet' \| 'testnet')` | VERIFIED | backend-core `connectWallet` |
| `signPsbt(hex, { autoFinalized, toSignInputs })`, returns hex | VERIFIED | ordinals-mint, backend-core |
| `toSignInputs[].sighashTypes` | VERIFIED (type only) | declared in the ordinals-mint interface, never exercised |
| `signMessage(msg, 'bip322-simple')` | VERIFIED | backend-core `signChallenge`; `'ecdsa'` in the counters-mint type |
| `pushTx({ rawtx })` | VERIFIED | backend-core |
| `pushPsbt(hex)` for `broadcast` | ASSUMED | UniSat docs |
| `disconnect()` (optional) | VERIFIED (type only) | degen-minter-3 declares it optional |
| `accountsChanged`, `networkChanged` events | VERIFIED | backend-core, ordinals-mint |
| `chainChanged` event | ASSUMED | UniSat docs |
| Rejection = `code 4001` or "reject" in message | VERIFIED | backend-core |
| No regtest chain | ASSUMED | not in UniSat's chain list |

### OKX

The legacy ordinals-mint `okx.ts` is itself marked "NEW, no prior implementation", so it was written from docs.
It is the best reference we have, but it is weaker evidence than production code.

| Detail | Status | Source |
|---|---|---|
| Per-network providers `bitcoin` / `bitcoinTestnet` / `bitcoinSignet` | VERIFIED (legacy, docs-derived) | ordinals-mint `okx.ts` + `okx.test.ts` |
| `connect()` returning `{ address, publicKey }` | VERIFIED (legacy, docs-derived) | ordinals-mint `okx.ts` |
| `signPsbt(hex, { autoFinalized, toSignInputs })` | VERIFIED (legacy, docs-derived) | ordinals-mint `okx.ts` |
| `accountChanged` event | VERIFIED (legacy, docs-derived) | ordinals-mint `okx.ts` |
| `bitcoinTestnet` is testnet4 | ASSUMED | legacy maps it to testnet4; OKX docs are ambiguous |
| `signMessage(msg, type)`, `pushTx(rawtx: string)`, `pushPsbt(hex)`, `disconnect()` | ASSUMED | OKX docs |
| Rejection `code 4001` | ASSUMED | EIP-1193 convention; message matching as fallback |

### Xverse

| Detail | Status | Source |
|---|---|---|
| `window.XverseProviders.BitcoinProvider.request(method, params)` | VERIFIED | ordinals-mint `xverse.ts`, counters-mint `isXverseAvailable` |
| `getAddresses { purposes, message, network: { type } }` returning `{ addresses[{ address, publicKey, purpose }] }` | VERIFIED | ordinals-mint `xverse.ts`; counters-mint via `@sats-connect/core` `getAddress` |
| Network types `Mainnet` / `Testnet4` / `Signet` | VERIFIED | ordinals-mint, counters-mint |
| `Regtest` network type | ASSUMED | sats-connect docs |
| `signPsbt { psbt: base64, signInputs: { address: index[] }, broadcast }` returning `{ psbt }` | VERIFIED | ordinals-mint, counters-mint |
| `txid` in the `signPsbt` result when broadcasting | ASSUMED | sats-connect docs |
| `wallet_connect { addresses, message, network }` and `network.bitcoin.name` in the result | ASSUMED | sats-connect docs |
| `getAccounts { purposes, message }` | ASSUMED | sats-connect docs |
| `signMessage { address, message, protocol }` returning `{ signature }` | ASSUMED | sats-connect docs |
| `wallet_disconnect` | ASSUMED | sats-connect docs; the Horizon adapter in counters.fun uses the same method on its sats-connect dialect |
| `addListener('accountChange' \| 'networkChange')` | ASSUMED | sats-connect docs |
| Errors resolved as `{ error: { code, message } }`, rejection `-32000` | ASSUMED (corroborated) | counters-mint checks `res.status !== 'success'` (errors do not throw); the counters.fun Horizon adapter maps `-32000` to rejection on its sats-connect dialect |

### Leather: all ASSUMED

The legacy repos have no Leather implementation (backend-core lists it as "planned"). The shapes below come
from Leather's public RPC docs: `getAddresses` returns `{ addresses: [{ symbol, type, address, publicKey }] }`;
`signPsbt { hex, signAtIndex, network, broadcast, allowedSighash }` returns `{ hex, txid? }`;
`signMessage { message, paymentType, network }` returns `{ signature, address }`; errors are rejected as
JSON-RPC responses with `4001` for user rejection. The adapter also accepts `-32000` and message text.

### Magic Eden: all ASSUMED

The legacy repos have no Magic Eden implementation. The adapter assumes `window.magicEden.bitcoin` speaks
the sats-connect `request` API (handled exactly like Xverse). For older builds that only expose the
sats-connect v1 surface, it falls back to `connect` / `signTransaction` / `signMessage` with unsecured-JWT
(`alg: none`) payloads. "Mainnet only" is a conservative assumption. Widen `networks` in `magiceden.ts` once
testnet support is confirmed.

## Differences from the legacy implementations

- **Errors are typed and thrown.** The legacy adapters returned `null` on any failure, so a user rejection
  looked the same as a broken wallet.
- **UniSat network switching is checked.** The ordinals-mint adapter called `switchChain` best-effort and
  ignored failures. backend-core mapped `testnet` to UniSat's old `testnet` (testnet3). Here the chain is read
  back after switching, and `testnet` means testnet4.
- **Xverse input mapping.** The ordinals-mint adapter put every index under one address (the first input's
  address, or the payment address). That is wrong when a PSBT spends both ordinals and payment inputs. Here
  `signInputs` is grouped by each input's address.
- **Both accounts are exposed.** The legacy shape was `{ address, ordinalsAddress?, publicKey }` with the
  ordinals public key only.
- **No `sendBitcoin`.** Legacy `funding.ts` and degen-minter-3 funded mints with `sendBitcoin(address, sats)`.
  The degent mint needs the funding txid before signing (ADR-0002 §2), so the kit only offers PSBT signing.

## Develop

```bash
pnpm --filter @bsh/wallet-kit test        # vitest + jsdom, fake providers under test/
pnpm --filter @bsh/wallet-kit typecheck
```

Each adapter's tests install a fake `window.*` provider that records every call. They assert account
mapping, PSBT encoding (hex vs base64) and input mapping, network selection and validation, user-rejection
mapping, and not-installed detection.
