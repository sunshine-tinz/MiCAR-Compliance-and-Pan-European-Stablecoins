/**
 * Stellar XDR decoder helpers.
 *
 * Wraps `TransactionBuilder.fromXDR` so the rest of the server can
 * treat a decoded `Transaction` as a value, not a result-of-a-throw.
 * Fee-bump transactions are explicitly rejected — the SEP-0008 hook
 * server protocol operates on regular transactions only.
 */

import { FeeBumpTransaction, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export type DecodedTx =
  | { ok: true; tx: Transaction; hash: Buffer }
  | { ok: false; error: string };

export function decodeTxXdr(xdr: string, networkPassphrase: string): DecodedTx {
  try {
    const built = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    // `fromXDR` returns `Transaction | FeeBumpTransaction`. The
    // SEP-0008 use case is regular transactions only — fee-bump
    // wrappers are not part of the protocol.
    if (built instanceof FeeBumpTransaction) {
      return {
        ok: false,
        error: "FeeBumpTransaction envelopes are not supported by the hook server",
      };
    }
    const hash = built.hash();
    return { ok: true, tx: built, hash };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
