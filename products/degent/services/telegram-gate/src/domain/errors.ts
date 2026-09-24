/** Every refusal the gate can give, with its HTTP status. Codes are listed in contracts/openapi/degent-telegram-gate.yaml. */
export type GateErrorCode =
  | 'bad_request'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'forbidden_origin'
  | 'rate_limited'
  | 'bad_telegram_id'
  | 'bad_token'
  | 'bad_address'
  | 'bad_message'
  | 'auth_failed'
  | 'not_a_holder'
  | 'address_taken'
  | 'telegram_taken'
  | 'unauthorized'
  | 'forbidden'
  | 'upstream_unavailable'
  | 'not_found'
  | 'internal';

export class GateError extends Error {
  constructor(
    readonly code: GateErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}
