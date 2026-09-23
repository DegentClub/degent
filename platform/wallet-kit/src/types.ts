/**
 * Provider-agnostic wallet surface. Every adapter normalises its browser
 * extension to these shapes, so mint code never branches on wallet id.
 *
 * Conventions:
 * - PSBTs cross this boundary as **base64**. Adapters convert to hex for the
 *   wallets that want hex (UniSat, OKX, Leather).
 * - Public keys are hex strings exactly as the wallet reports them.
 * - `testnet` means **testnet4** wherever a wallet distinguishes testnet3 from
 *   testnet4 (UniSat, Xverse). See README for per-wallet caveats.
 */

export type WalletId = 'unisat' | 'xverse' | 'leather' | 'okx' | 'magiceden';

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export type AddressType = 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'unknown';

export type AddressPurpose = 'ordinals' | 'payment';

export interface WalletAccount {
  address: string;
  /** Hex, as reported by the wallet (compressed 33-byte key or x-only 32-byte key). */
  publicKey: string;
  purpose: AddressPurpose;
  addressType: AddressType;
}

export interface InputToSign {
  index: number;
  /** The wallet address that owns this input. Must be the ordinals or payment address. */
  address: string;
  /** Allowed sighash types. Forwarded where the wallet supports it (see README). */
  sighashTypes?: number[];
}

export interface SignPsbtOptions {
  inputsToSign: InputToSign[];
  /** Ask the wallet to finalize signed inputs. Default false. Forced true when `broadcast` is set. */
  finalize?: boolean;
  /** Ask the wallet to broadcast the finalized transaction. Default false. */
  broadcast?: boolean;
}

export interface SignPsbtResult {
  psbtBase64: string;
  /** Present when `broadcast` was requested and the wallet reported the txid. */
  txid?: string;
}

export type MessageSignatureType = 'bip322-simple' | 'ecdsa';

export interface ConnectedWallet {
  id: WalletId;
  network: Network;
  ordinals: WalletAccount;
  payment: WalletAccount;
  signPsbt(psbtBase64: string, opts: SignPsbtOptions): Promise<SignPsbtResult>;
  signMessage(message: string, address: string, type?: MessageSignatureType): Promise<string>;
  /** Broadcast a raw transaction through the wallet. Only on wallets that can relay. */
  pushTx?(hex: string): Promise<string>;
  disconnect(): Promise<void>;
  /**
   * Subscribe to the wallet switching account/network underneath us. Only on
   * wallets that emit such events. Returns an unsubscribe function.
   */
  onAccountsChanged?(cb: () => void): () => void;
}

export interface ConnectOptions {
  network: Network;
}

export interface WalletAdapter {
  id: WalletId;
  name: string;
  icon?: string;
  installUrl: string;
  /** Networks this adapter can connect to. `connect` throws UnsupportedNetworkError otherwise. */
  networks: readonly Network[];
  isInstalled(): boolean;
  connect(opts: ConnectOptions): Promise<ConnectedWallet>;
}
