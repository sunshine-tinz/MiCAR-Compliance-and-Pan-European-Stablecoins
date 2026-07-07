/**
 * Stellar XDR decoder helpers.
 *
 * Wraps `TransactionBuilder.fromXDR` so the rest of the server can
 * treat a decoded `Transaction` as a value, not a result-of-a-throw.
 * Fee-bump transactions are explicitly rejected — the SEP-0008 hook
 * server protocol operates on regular transactions only.
 *
 * `extractTransferAmount` walks the transaction's operations looking
 * for the outgoing transfer amount, so the velocity-limit check
 * (MiCAR Art. 46) can compare it against `emt_token`'s 24h cap.
 */

import {
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Body shape we read from each operation. We deliberately do NOT import
 * `Operation` from `@stellar/stellar-sdk` for the parameter type here:
 * SDK 12's `Transaction.operations` returns high-level wrapper instances
 * whose `.switch()` lives on the inner xdr body returned by `.body()`.
 * `extractTransferAmount` does the `.body()` unwrap via a runtime guard
 * before handing the value to `extractAmountFromOp`.
 *
 * `args()` is typed as the actual SDK `xdr.ScVal[]` so each entry can
 * be passed straight to `scValToNative` without re-assertion at the
 * call site. SYNC with @stellar/stellar-sdk v12.x — if a body field
 * renames in a future major, this interface is the canary.
 */
interface OpBody {
  switch(): { value: number };
  paymentOp(): { amount(): { toString(): string } } | null | undefined;
  invokeHostFunctionOp(): {
    hostFunction(): {
      switch(): { value: number };
      invokeContract(): { args(): readonly xdr.ScVal[] };
    };
  } | null | undefined;
}

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

/**
 * Best-effort recovery of the outgoing transfer amount from a decoded
 * transaction. Returns `null` when the structure is not recognizable
 * (e.g. account-merging ops, claimable balances, or anything outside
 * the two patterns below).
 *
 * Patterns supported:
 *
 *  1. **Native payment op** (`body.switch().value === payment().value`):
 *     `amount` is read straight from `body.paymentOp().amount()`. The
 *     seventh-decimal scaling matches EUREMT (7 dp), so the returned
 *     bigint is directly comparable to `get_outflow_today` + the
 *     `additionalAmount` projection in `LimitsProvider.wouldExceed`.
 *
 *  2. **Soroban invokeHostFunction op**
 *  (`body.switch().value === invokeHostFunction().value`)
 *     whose host function is `invokeContract`: the args list is
 *     scanned for the first ScVal with `switch().value === scvI128().value`.
 *     This matches both `transfer(env, from, to, amount)` (third positional
 *     arg) and `transfer_from(env, spender, from, to, amount)` (fourth
 *     positional arg) — i128 is the contract-side type for amount in
 *     both signatures. Address args (ScVal `scvAddress`) are skipped
 *     without confusion because their switch is `scvAddress`, not
 *     `scvI128`.
 *
 * Non-transaction-internal ops (clawback, manage-data, etc.) are
 * skipped; the function returns `null` if no amount-bearing op is
 * found, which means the velocity check is skipped (the handler
 * treats the "no amount" case the same as zero amount).
 */
export function extractTransferAmount(tx: Transaction): bigint | null {
  for (const op of tx.operations) {
    // SDK 12 returns wrapper `Operation` instances from `tx.operations`;
    // the inner xdr body — where `.switch()` lives — is one `.body()`
    // call away. We guard at runtime so a future SDK major that exposes
    // the body directly still works (the guard returns the op itself
    // when `.body` isn't a callable method).
    const inner = readOpBody(op);
    const amount = extractAmountFromOp(inner);
    if (amount !== null) return amount;
  }
  return null;
}

function readOpBody(op: unknown): OpBody {
  if (
    op !== null &&
    typeof op === "object" &&
    typeof (op as { body?: unknown }).body === "function"
  ) {
    // SDK 12's high-level Operation wrapper exposes the inner xdr body
    // via `.body()`. The function-typed cast below is needed because
    // TS 5.x disallows `.call(...)` on a value of type `unknown`
    // (TS2571); we explicitly type `.body()` as `Function` to make the
    // `.call` site checkable.
    const bodyFn = (op as { body: () => unknown }).body() as Function;
    return bodyFn.call(op) as unknown as OpBody;
  }
  return op as OpBody;
}

function extractAmountFromOp(body: OpBody): bigint | null {
  // ── Native payment ──────────────────────────────────────────────────────
  // Compare the **numeric switch value** against the static enum. SDK
  // minors vary in whether `switch()` returns an enum instance or a
  // primitive number; comparing `.value` is portable across both
  // styles. A silent fall-through here would disable the velocity
  // check entirely — an Art. 46 compliance fault.
  if (body.switch().value === xdr.OperationType.payment().value) {
    const payment = body.paymentOp();
    if (!payment) return null;
    // `amount` is an xdr.Int64. Surface contract violations loudly —
    // a non-numeric value is unexpected and worth crashing, not swallowing.
    return BigInt(payment.amount().toString());
  }

  // ── Soroban invokeHostFunction ───────────────────────────────────────────
  if (
    body.switch().value === xdr.OperationType.invokeHostFunction().value
  ) {
    const invoke = body.invokeHostFunctionOp();
    if (!invoke) return null;
    const hostFn = invoke.hostFunction();
    if (
      hostFn.switch().value !==
      xdr.HostFunctionType.hostFunctionTypeInvokeContract().value
    ) {
      return null;
    }
    const args = hostFn.invokeContract().args();
    for (const scArg of args) {
      if (scArg.switch().value === xdr.ScValType.scvI128().value) {
        const native = scValToNative(scArg);
        if (typeof native === "bigint") return native;
        // `scValToNative` may return a numeric in some SDK interop layers;
        // coerce defensively. If that coercion fails, let it throw — the
        // ScVal claims to be an i128 but isn't representable as bigint,
        // which means there's a real bug upstream.
        return BigInt(String(native));
      }
    }
  }

  return null;
}
