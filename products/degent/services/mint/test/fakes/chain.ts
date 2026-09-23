/** In-memory regtest-like chain + ord for tests. Deterministic; no network. */
import { hex } from '@scure/base';
import { Address, OutScript, Transaction } from '@scure/btc-signer';
import { networkParams, type Network } from '@bsh/inscription';
import type { AddressOutput, ChainOutspend, ChainPort, ChainTx } from '../../src/ports/chain.js';

export interface FakeTx {
  txid: string;
  vin: Array<{ txid: string; vout: number }>;
  vout: Array<{ value: bigint; scriptHex: string }>;
  blockHeight: number | null;
  raw?: string;
}

export class FakeChain implements ChainPort {
  readonly txs = new Map<string, FakeTx>();
  readonly inscriptions = new Map<string, Uint8Array>();
  tip = 100;
  /** When set, calls throw (simulates an unreachable backend). */
  down = false;

  constructor(readonly network: Network = 'regtest') {}

  private guard() {
    if (this.down) throw new Error('chain backend down');
  }

  addTx(tx: Omit<FakeTx, 'blockHeight'> & { confirmed?: boolean }): FakeTx {
    const t: FakeTx = { ...tx, blockHeight: tx.confirmed ? this.tip : null };
    this.txs.set(t.txid, t);
    return t;
  }

  /** Accepts a raw tx into the "mempool" (like sendrawtransaction). Returns its txid. */
  acceptRaw(rawHex: string): string {
    const tx = Transaction.fromRaw(hex.decode(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
    const vin = Array.from({ length: tx.inputsLength }, (_, i) => {
      const inp = tx.getInput(i);
      return { txid: hex.encode(inp.txid!), vout: inp.index! };
    });
    for (const i of vin) {
      const spent = this.spenderOf(i.txid, i.vout);
      if (spent && spent !== tx.id) throw new Error(`bad-txns-inputs-missingorspent (${i.txid}:${i.vout})`);
    }
    const vout = Array.from({ length: tx.outputsLength }, (_, i) => {
      const o = tx.getOutput(i);
      return { value: o.amount!, scriptHex: hex.encode(o.script!) };
    });
    this.addTx({ txid: tx.id, vin, vout, raw: rawHex });
    return tx.id;
  }

  spenderOf(txid: string, vout: number): string | null {
    for (const t of this.txs.values()) if (t.vin.some((i) => i.txid === txid && i.vout === vout)) return t.txid;
    return null;
  }

  /** Mine one block containing every mempool tx. */
  mine(blocks = 1): void {
    this.tip += blocks;
    for (const t of this.txs.values()) if (t.blockHeight === null) t.blockHeight = this.tip - blocks + 1;
  }

  /** Drop an unconfirmed tx (evicted from mempools). */
  evict(txid: string): void {
    const t = this.txs.get(txid);
    if (t && t.blockHeight === null) this.txs.delete(txid);
  }

  private address(scriptHex: string): string | null {
    try {
      return Address(networkParams(this.network)).encode(OutScript.decode(hex.decode(scriptHex)));
    } catch {
      return null;
    }
  }

  async getTx(txid: string): Promise<ChainTx | null> {
    this.guard();
    const t = this.txs.get(txid);
    if (!t) return null;
    return {
      txid,
      vout: t.vout.map((o) => ({ ...o, address: this.address(o.scriptHex) })),
      confirmed: t.blockHeight !== null,
      blockHeight: t.blockHeight,
    };
  }

  async getTxOutspends(txid: string): Promise<ChainOutspend[] | null> {
    this.guard();
    const t = this.txs.get(txid);
    if (!t) return null;
    return t.vout.map((_, i) => {
      const s = this.spenderOf(txid, i);
      const vin = s ? this.txs.get(s)!.vin.findIndex((x) => x.txid === txid && x.vout === i) : null;
      return { spent: s !== null, txid: s, vin };
    });
  }

  async findOutputsPaying(address: string): Promise<AddressOutput[]> {
    this.guard();
    const out: AddressOutput[] = [];
    for (const t of this.txs.values())
      t.vout.forEach((o, i) => {
        if (this.address(o.scriptHex) === address && !this.spenderOf(t.txid, i))
          out.push({ txid: t.txid, vout: i, value: o.value, confirmed: t.blockHeight !== null });
      });
    return out;
  }

  async getTipHeight(): Promise<number> {
    this.guard();
    return this.tip;
  }

  async getInscriptionContent(id: string): Promise<Uint8Array | null> {
    this.guard();
    return this.inscriptions.get(id) ?? null;
  }
}
