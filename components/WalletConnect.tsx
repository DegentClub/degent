'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import WalletPicker from '@/components/WalletPicker';
import { useToast } from '@/components/Toast';
import { explainTaprootRequirement, isTaproot } from '@/lib/address';
import type { WalletInfo } from '@/lib/mint-machine';
import { getAdapter, rememberWallet, walletAdapters, WalletError, type WalletAdapter } from '@/lib/wallet';

interface WalletConnectProps {
  wallet: WalletInfo | null;
  recipient: string | null;
  /** True while an order is in flight; changing wallets then is not allowed. */
  locked: boolean;
  onConnected: (wallet: WalletInfo, suggestedRecipient: string | null) => void;
  onDisconnected: () => void;
  onRecipientChange: (address: string | null) => void;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export default function WalletConnect({
  wallet,
  recipient,
  locked,
  onConnected,
  onDisconnected,
  onRecipientChange,
}: WalletConnectProps) {
  const { notify } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingRecipient, setEditingRecipient] = useState(false);
  const [recipientDraft, setRecipientDraft] = useState('');
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const unsubscribeRef = useRef<() => void>();

  const disconnect = useCallback(
    async (reason?: string) => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      const adapter = wallet ? getAdapter(wallet.walletId) : undefined;
      await adapter?.disconnect().catch(() => undefined);
      rememberWallet(null);
      setEditingRecipient(false);
      onDisconnected();
      if (reason) notify(reason, 'info');
    },
    [wallet, onDisconnected, notify]
  );

  useEffect(() => () => unsubscribeRef.current?.(), []);

  const handleSelect = async (adapter: WalletAdapter) => {
    setBusyId(adapter.id);
    try {
      const account = await adapter.connect();

      if (account.network !== 'mainnet') {
        await adapter.disconnect().catch(() => undefined);
        const label = account.network === 'unknown' ? 'an unrecognised network' : account.network;
        throw new WalletError(
          `${adapter.name} is on ${label}. Switch the wallet to Bitcoin mainnet and connect again.`,
          'network'
        );
      }

      const info: WalletInfo = {
        walletId: adapter.id,
        walletName: adapter.name,
        address: account.address,
        publicKey: account.publicKey,
        network: account.network,
      };

      const candidate = [account.ordinalsAddress, account.address].find((a) => a && isTaproot(a)) ?? null;

      unsubscribeRef.current?.();
      unsubscribeRef.current = adapter.onAccountsChanged(() => {
        void disconnect('Wallet account changed. Please connect again.');
      });

      rememberWallet(adapter.id);
      setPickerOpen(false);
      setEditingRecipient(candidate === null);
      setRecipientDraft('');
      setRecipientError(null);
      onConnected(info, candidate);
      if (!candidate) {
        notify('Your wallet address is not taproot. Enter a bc1p address to receive the inscription.', 'info', 8000);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Wallet connection failed.';
      notify(message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const commitRecipient = () => {
    const problem = explainTaprootRequirement(recipientDraft);
    if (problem) {
      setRecipientError(problem);
      return;
    }
    setRecipientError(null);
    setEditingRecipient(false);
    onRecipientChange(recipientDraft.trim());
  };

  return (
    <section id="wallet-connect-section" className="degent-card" aria-labelledby="wallet-title">
      <h2 id="wallet-title" className="degent-title h2">
        <span className="icon-square">
          <i className="fas fa-wallet text-degent-green" aria-hidden="true"></i>
        </span>
        <span>Connect Wallet</span>
      </h2>

      {!wallet ? (
        <div>
          <p className="text-degent-muted mb-4">
            Connect a Bitcoin mainnet wallet. UniSat, Xverse, Leather, OKX and Magic Eden are supported.
          </p>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={busyId !== null}
            className="btn btn-flex btn-gradient btn-curtain w-full"
          >
            <i className="fas fa-link" aria-hidden="true"></i>
            <span>Connect Wallet</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="label-icon">
              <i className="fas fa-check-circle text-degent-green" aria-hidden="true"></i>
              {wallet.walletName} · pays from
            </p>
            <p className="degent-field-bg text-degent-green text-sm" title={wallet.address}>
              <i className="fas fa-wallet" aria-hidden="true"></i>
              <span className="hidden sm:inline">{wallet.address}</span>
              <span className="sm:hidden">{shortAddress(wallet.address)}</span>
            </p>
          </div>

          <div>
            <p className="label-icon">
              <i className="fas fa-gem text-degent-green" aria-hidden="true"></i>
              Inscription goes to (taproot, bc1p)
            </p>
            {recipient && !editingRecipient ? (
              <div className="degent-field-bg text-sm">
                <span className="break-all">{recipient}</span>
                {!locked && (
                  <button
                    type="button"
                    className="ml-auto shrink-0 text-degent-muted hover:text-white"
                    onClick={() => {
                      setRecipientDraft(recipient);
                      setEditingRecipient(true);
                    }}
                    aria-label="Change recipient address"
                  >
                    <i className="fas fa-pen" aria-hidden="true"></i>
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <label htmlFor="recipient-input" className="sr-only">
                  Taproot recipient address
                </label>
                <input
                  id="recipient-input"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="bc1p..."
                  value={recipientDraft}
                  disabled={locked}
                  onChange={(e) => {
                    setRecipientDraft(e.target.value);
                    setRecipientError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRecipient();
                  }}
                  aria-invalid={recipientError ? true : undefined}
                  aria-describedby="recipient-help"
                  className="bg-degent-input border border-degent-border focus:border-degent-green focus:ring-1 focus:ring-degent-green outline-none px-4 py-3 rounded-degent-button text-white font-mono text-sm w-full"
                />
                <p id="recipient-help" className={`text-xs ${recipientError ? 'text-red-400' : 'text-degent-muted'}`}>
                  {recipientError ??
                    'Your connected address is not taproot. Paste a bc1p address you control (most wallets have one under "Ordinals").'}
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={commitRecipient} disabled={locked} className="btn btn-flex btn-neon flex-1 !py-2 !text-sm">
                    <i className="fas fa-check" aria-hidden="true"></i>
                    Use this address
                  </button>
                  {recipient && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingRecipient(false);
                        setRecipientError(null);
                      }}
                      className="btn btn-flex btn-idle !py-2 !text-sm"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={locked}
            className="w-full btn btn-flex btn-idle"
          >
            <i className="fas fa-sign-out-alt" aria-hidden="true"></i>
            Disconnect
          </button>
        </div>
      )}

      <WalletPicker
        open={pickerOpen}
        adapters={walletAdapters}
        busyId={busyId}
        onSelect={(adapter) => void handleSelect(adapter)}
        onClose={() => busyId === null && setPickerOpen(false)}
      />
    </section>
  );
}
