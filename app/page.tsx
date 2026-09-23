'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import WalletConnect from '@/components/WalletConnect';
import AIInstructions from '@/components/AIInstructions';
import FileUpload from '@/components/FileUpload';
import FileValidation from '@/components/FileValidation';
import MintButton from '@/components/MintButton';
import OrderTracker from '@/components/OrderTracker';
import HeroSection from '@/components/HeroSection';
import SocialJoin from '@/components/SocialJoin';
import Stepper from '@/components/Stepper';
import { useToast } from '@/components/Toast';
import { ApiError, createInscriptionCommit, hashFile, isAcceptedMime, isFileSizeValid } from '@/lib/api';
import { fetchBtcUsdPrice, fetchMempoolPresets, type FeePresets } from '@/lib/fees';
import {
  canMint,
  currentQuoteKey,
  initialMintState,
  isOrderLocked,
  mintReducer,
  quoteTargetId,
} from '@/lib/mint-machine';
import { latestOrder, saveOrder, updateOrder, type StoredOrder } from '@/lib/orders';
import { getAdapter } from '@/lib/wallet';

const QUOTE_DEBOUNCE_MS = 600;

export default function Home() {
  const { notify } = useToast();
  const [state, dispatch] = useReducer(mintReducer, initialMintState);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [submitFile, setSubmitFile] = useState<File | null>(null);
  const [presets, setPresets] = useState<FeePresets | null>(null);
  const [usdPerBtc, setUsdPerBtc] = useState<number | null>(null);
  const [activeOrder, setActiveOrder] = useState<StoredOrder | null>(null);

  // Refs let async callbacks read the latest state without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;
  const submitFileRef = useRef(submitFile);
  submitFileRef.current = submitFile;
  const quoteCounter = useRef(0);
  const hashCounter = useRef(0);
  const payingRef = useRef(false);

  // Restore an in-flight order after a refresh.
  useEffect(() => {
    const existing = latestOrder();
    if (existing && !existing.dismissed) setActiveOrder(existing);
  }, []);

  // Fee presets and BTC price are best-effort decorations.
  useEffect(() => {
    let cancelled = false;
    void fetchMempoolPresets().then((p) => !cancelled && setPresets(p));
    void fetchBtcUsdPrice().then((p) => !cancelled && setUsdPerBtc(p));
    return () => {
      cancelled = true;
    };
  }, []);

  // Hash whatever file is about to be submitted and tell the machine about it.
  useEffect(() => {
    const id = ++hashCounter.current;
    if (!submitFile) {
      dispatch({ type: 'FILE_CLEARED' });
      return;
    }
    void hashFile(submitFile).then((hash) => {
      if (id !== hashCounter.current) return;
      dispatch({
        type: 'FILE_SET',
        file: {
          hash,
          size: submitFile.size,
          name: submitFile.name,
          type: submitFile.type,
          valid: isAcceptedMime(submitFile.type) && isFileSizeValid(submitFile.size),
        },
      });
    });
  }, [submitFile]);

  // Debounced quote fetch, keyed on the exact inputs. A change in any input
  // changes `target`, which aborts the in-flight request and starts over.
  const target = quoteTargetId(state);
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    const requestId = ++quoteCounter.current;

    const timer = window.setTimeout(async () => {
      const current = stateRef.current;
      const key = currentQuoteKey(current);
      const file = submitFileRef.current;
      if (!key || !file || !current.wallet) return;

      dispatch({ type: 'QUOTE_STARTED', requestId, key });
      try {
        const quote = await createInscriptionCommit({
          file,
          recipientAddress: key.recipient,
          feeRate: key.feeRate,
          senderAddress: current.wallet.address,
          signal: controller.signal,
        });
        dispatch({ type: 'QUOTE_SUCCEEDED', requestId, quote: { key, ...quote } });
      } catch (err) {
        if (controller.signal.aborted) return;
        const message =
          err instanceof ApiError
            ? `${err.message}${err.requestId ? ` (ref ${err.requestId.slice(0, 8)})` : ''}`
            : 'Could not get a quote. Please try again.';
        dispatch({ type: 'QUOTE_FAILED', requestId, error: message });
        notify(message, 'error');
      }
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `target` already encodes every input the quote depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const handleMint = async () => {
    const current = stateRef.current;
    if (payingRef.current || !canMint(current) || !current.quote || !current.wallet) return;
    payingRef.current = true;
    dispatch({ type: 'PAY_STARTED' });

    const { quote, wallet } = current;
    try {
      const adapter = getAdapter(wallet.walletId);
      if (!adapter) throw new Error('Wallet adapter not found. Please reconnect.');
      const txid = await adapter.sendBitcoin(quote.paymentAddress, quote.amountSats, { feeRate: quote.key.feeRate });
      const paidAt = Date.now();
      dispatch({ type: 'PAY_SUCCEEDED', txid, paidAt });
      const order: StoredOrder = {
        inscriptionId: quote.inscriptionId,
        paymentAddress: quote.paymentAddress,
        txid,
        amountSats: quote.amountSats,
        feeRate: quote.key.feeRate,
        fileHash: quote.key.fileHash,
        fileName: current.file?.name ?? '',
        recipient: quote.key.recipient,
        createdAt: paidAt,
        status: 'paid',
      };
      saveOrder(order);
      setActiveOrder(order);
      notify('Payment sent. Tracking the transaction now.', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Payment failed.';
      dispatch({ type: 'PAY_FAILED', error: message });
      notify(message, 'error');
    } finally {
      payingRef.current = false;
    }
  };

  const handleOrderUpdate = useCallback((patch: Partial<Omit<StoredOrder, 'txid'>>) => {
    setActiveOrder((order) => {
      if (!order) return order;
      const updated = updateOrder(order.txid, patch) ?? { ...order, ...patch };
      if (patch.status && patch.status !== 'paid') dispatch({ type: 'PAYMENT_CONFIRMED' });
      return updated;
    });
  }, []);

  const handleMintAnother = () => {
    if (activeOrder) updateOrder(activeOrder.txid, { dismissed: true });
    setActiveOrder(null);
    setOriginalFile(null);
    setSubmitFile(null);
    dispatch({ type: 'RESET' });
  };

  const locked = isOrderLocked(state) || activeOrder !== null;

  return (
    <>
      <HeroSection />

      <main className="bg-dark-gradient-fade">
        <div className="container">
          <Stepper state={state} />

          <WalletConnect
            wallet={state.wallet}
            recipient={state.recipient}
            locked={locked}
            onConnected={(wallet, suggestedRecipient) => {
              dispatch({ type: 'WALLET_CONNECTED', wallet });
              dispatch({ type: 'RECIPIENT_SET', recipient: suggestedRecipient });
            }}
            onDisconnected={() => dispatch({ type: 'WALLET_DISCONNECTED' })}
            onRecipientChange={(recipient) => dispatch({ type: 'RECIPIENT_SET', recipient })}
          />

          {activeOrder ? (
            <OrderTracker order={activeOrder} onUpdate={handleOrderUpdate} onMintAnother={handleMintAnother} />
          ) : (
            <>
              <AIInstructions />

              <FileUpload onFileSelect={setOriginalFile} disabled={locked} />

              <FileValidation originalFile={originalFile} onCompressedFile={setSubmitFile} disabled={locked} />

              <MintButton
                state={state}
                dispatch={dispatch}
                presets={presets}
                usdPerBtc={usdPerBtc}
                onMint={() => void handleMint()}
              />
            </>
          )}
        </div>
      </main>
      <SocialJoin />
    </>
  );
}
