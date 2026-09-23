# Skrybit API facts

The only upstream this app talks to. Everything below is what the app relies
on; anything else in the old `build-instructions/` was implementation
narrative and has been dropped.

## Base URL

`https://api.skrybit.io` (override with `SKRYBIT_API_URL`).

## Authentication

`Authorization: Bearer <SKRYBIT_API_KEY>` on every request. The key is held
server-side only and never reaches the browser.

## `POST /inscriptions/create-commit`

`Content-Type: multipart/form-data`

| Field               | Type   | Notes                                                        |
| ------------------- | ------ | ------------------------------------------------------------ |
| `file`              | file   | Image to inscribe. The app enforces `image/*`, 200–400 KB.   |
| `recipient_address` | string | Address that receives the inscription. The app requires bc1p. |
| `fee_rate`          | string | sats/vB, decimal allowed (e.g. `"1"`, `"0.13"`).             |
| `sender_address`    | string | Address that will pay the commit.                            |

Response `200`:

```json
{
  "required_amount_in_sats": "12345",
  "payment_address": "bc1q...",
  "inscription_id": "..."
}
```

- `required_amount_in_sats` is a **string**; parse it as an integer.
- `payment_address` is where the user's wallet sends exactly that amount.
- `inscription_id` is Skrybit's identifier for the order. It is shown in the
  tracker so the user can quote it to support. It is only linked to
  ordinals.com when it has the `<txid>i<n>` shape.

Errors: `400` invalid request, `401` bad/missing key, `500` upstream failure.
The proxy never forwards upstream error bodies to the browser.

## Flow

1. App requests a quote (`create-commit`) with the final image bytes.
2. User pays `required_amount_in_sats` to `payment_address` from their wallet.
3. Once the payment confirms, Skrybit broadcasts the reveal to `recipient_address`.

## Not available

There is no documented endpoint to poll an inscription's status by id. The
tracker therefore watches the payment transaction on mempool.space and stops
at "confirmed"; the reveal step is informational. If Skrybit publishes a status
endpoint, add a proxy under `app/api/inscriptions/[id]/route.ts` with the same
key handling and rate limiting as `create-commit`.

## The 200 KB floor

Nothing in the Skrybit contract requires a minimum size. The 200 KB floor is a
collection rule enforced by this app's proxy (`lib/api.ts`). Keep or change it
there.
