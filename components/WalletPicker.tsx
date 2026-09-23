'use client';

import { useEffect, useRef } from 'react';
import type { WalletAdapter } from '@/lib/wallet';

interface WalletPickerProps {
  open: boolean;
  adapters: WalletAdapter[];
  busyId: string | null;
  onSelect: (adapter: WalletAdapter) => void;
  onClose: () => void;
}

export default function WalletPicker({ open, adapters, busyId, onSelect, onClose }: WalletPickerProps) {
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        className="degent-card w-full max-w-md !space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="wallet-picker-title" className="degent-title h3 !mb-0">
            <span className="icon-square">
              <i className="fas fa-wallet text-degent-green text-sm" aria-hidden="true"></i>
            </span>
            Choose a wallet
          </h2>
          <button type="button" onClick={onClose} aria-label="Close wallet picker" className="text-degent-muted hover:text-white">
            <i className="fas fa-xmark text-lg" aria-hidden="true"></i>
          </button>
        </div>
        <p className="text-sm text-degent-muted">Mainnet only. Payments come from the wallet; the inscription goes to a taproot address.</p>
        <ul className="space-y-2">
          {adapters.map((adapter, index) => {
            const installed = adapter.isInstalled();
            const busy = busyId === adapter.id;
            return (
              <li key={adapter.id}>
                {installed ? (
                  <button
                    ref={index === 0 ? firstButton : undefined}
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => onSelect(adapter)}
                    className="btn btn-flex btn-idle w-full !justify-between"
                  >
                    <span>{adapter.name}</span>
                    {busy ? (
                      <i className="fas fa-spinner fa-spin" aria-hidden="true"></i>
                    ) : (
                      <span className="text-xs text-degent-green">Detected</span>
                    )}
                  </button>
                ) : (
                  <a
                    href={adapter.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-flex btn-idle w-full !justify-between opacity-70"
                  >
                    <span>{adapter.name}</span>
                    <span className="text-xs text-degent-muted">
                      Install <i className="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>
                    </span>
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
