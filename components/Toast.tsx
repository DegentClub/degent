'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export type ToastKind = 'error' | 'success' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  notify: (message: string, kind?: ToastKind, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_CLASSES: Record<ToastKind, string> = {
  error: 'border-red-500 bg-red-900/80 text-red-100',
  success: 'border-degent-green bg-degent-green/20 text-degent-green',
  info: 'border-degent-border bg-degent-card text-white',
};

const KIND_ICON: Record<ToastKind, string> = {
  error: 'fa-triangle-exclamation',
  success: 'fa-circle-check',
  info: 'fa-circle-info',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = 'info', ttlMs = 6000) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, kind, message }]);
      if (ttlMs > 0) window.setTimeout(() => dismiss(id), ttlMs);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-3 rounded-degent-button border px-4 py-3 text-sm shadow-lg backdrop-blur-sm ${KIND_CLASSES[toast.kind]}`}
          >
            <i className={`fas ${KIND_ICON[toast.kind]} mt-0.5`} aria-hidden="true"></i>
            <span className="flex-1 break-words">{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="opacity-70 hover:opacity-100"
            >
              <i className="fas fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
