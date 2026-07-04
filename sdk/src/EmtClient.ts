/**
 * EMT Token SDK Client
 *
 * TypeScript wrapper for the Soroban EMT token contract.
 *
 * ## Quick Start
 * ```ts
 * import { EmtClient, Networks } from "@eur-emt/sdk";
 *
 * const client = new EmtClient({
 *   contractId: "C...",
 *   networkPassphrase: Networks.TESTNET,
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 * });
 *
 * const balance = await client.getBalance("G...");
 * ```
 *
 * ## Caveats
 *
 * - **Read methods** use `simulateTransaction` with a randomly-generated
 *   source keypair — this works against every public Soroban RPC but may
 *   be rejected by mainnet-grade RPCs that enforce source-account funding
 *   even for simulations.
 * - **Reads are eventually consistent**: a write that has just landed may
 *   take 1–2 ledgers (~5–10 s) to be visible to subsequent simulations.
 *
 * ## Errors
 * All RPC / simulation / contract-panic failures throw {@link EmtClientError}.
 */

import {
  Account,
  Address,
  BASE_FEE as SDK_BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  scValToNative,
  SorobanRpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Coerce `BASE_FEE` (string in some SDK minors, number in others) to a
 * number. Default is 100 stroops.
 */
const DEFAULT_BASE_FEE_NUM: number =
  typeof SDK_BASE_FEE === "string" ? Number(SDK_BASE_FEE) : SDK_BASE_FEE;

/** SDK TransactionBuilder wants a string for `fee`. */
function feeToString(fee: number): string {
  return fee.toString();
}

/** Convert a native value from `scValToNative` to a bigint. */
function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(String(value));
}

/** Convert a native value from `scValToNative` to a JS number. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return Number(value);
}

/** Convert a native value from `scValToNative` to a string. */
function toString(value: unknown): string {
  return String(value);
}

// ── Public Types ──────────────────────────────────────────────────────────────

export interface EmtClientConfig {
  /** Contract address (`C...`). */
  contractId: string;
  /** Network passphrase (e.g. `Networks.TESTNET`). */
  networkPassphrase: string;
  /** Soroban RPC URL. */
  rpcUrl: string;
  /**
   * Optional override for the transaction base fee (in stroops).
   * Defaults to the SDK's `BASE_FEE`.
   */
  baseFee?: number;
}

/** Result of a submitted write call. */
export interface SubmitResult {
  /** Transaction hash. */
  hash: string;
  /** Decoded return value, if any. */
  result: unknown;
  /** Status returned by the RPC. */
  status: string;
}

/**
 * Thrown by read or write helpers on RPC / simulation / contract errors.
 * The original error is retained in `.cause` for inspection.
 */
export class EmtClientError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "EmtClientError";
    this.cause = cause;
  }
}

/**
 * Result of {@link EmtClient.extendStorageTtl}. Splits the touched
 * entries by kind so the calling cron / governance action can log them
 * distinctly (e.g., to detect drift in the address book vs. the
 * allowance book).
 *
 * Field names are kept in snake_case to match the underlying Soroban
 * contract struct (`TtlExtendResult { addresses_touched, allowance_pairs_touched }`),
 * which `scValToNative` round-trips without case conversion.
 */
export interface TtlExtendResult {
  addresses_touched: number;
  allowance_pairs_touched: number;
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * High-level Soroban client for the MiCAR EMT contract.
 *
 * - Read methods:
 *   `simulateTransaction` against an unfunded random source account.
 * - Write methods:
 *   `build → simulate → assembleTransaction (footprint + fee) → build →
 *    sign → sendTransaction → poll getTransaction until confirmed`.
 *
 * Compatible with `@stellar/stellar-sdk@12.x`.
 */
export class EmtClient {
  private readonly contract: Contract;
  private readonly server: SorobanRpc.Server;
  private readonly baseFee: string;
  private readonly networkPassphrase: string;

  constructor(config: EmtClientConfig) {
    if (!config.contractId) throw new EmtClientError("contractId is required");
    if (!config.networkPassphrase)
      throw new EmtClientError("networkPassphrase is required");
    if (!config.rpcUrl) throw new EmtClientError("rpcUrl is required");

    const feeNum =
      typeof config.baseFee === "number" && !Number.isNaN(config.baseFee)
        ? config.baseFee
        : DEFAULT_BASE_FEE_NUM;
    this.baseFee = feeToString(feeNum);
    this.networkPassphrase = config.networkPassphrase;

    this.contract = new Contract(config.contractId);
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  /** Get the balance of `account` (7 decimal places, smallest unit). */
  async getBalance(account: string): Promise<bigint> {
    return toBigInt(await this.simulateView("balance", [this.addressArg(account)]));
  }

  /** Get the current total supply. */
  async getTotalSupply(): Promise<bigint> {
    return toBigInt(await this.simulateView("total_supply", []));
  }

  /** True if the contract is in the paused state. */
  async isPaused(): Promise<boolean> {
    return Boolean(await this.simulateView("is_paused", []));
  }

  /** True if `account` is on the blocklist. */
  async isBlocklisted(account: string): Promise<boolean> {
    return Boolean(
      await this.simulateView("is_blocklisted", [this.addressArg(account)])
    );
  }

  /** Allowance granted by `owner` to `spender`. */
  async getAllowance(owner: string, spender: string): Promise<bigint> {
    return toBigInt(
      await this.simulateView("allowance", [
        this.addressArg(owner),
        this.addressArg(spender),
      ])
    );
  }

  /** Token name (e.g. "Euro EMT"). */
  async getName(): Promise<string> {
    return toString(await this.simulateView("name", []));
  }

  /** Token symbol (e.g. "EUREMT"). */
  async getSymbol(): Promise<string> {
    return toString(await this.simulateView("symbol", []));
  }

  /** Decimal places (always 7 for this token). */
  async getDecimals(): Promise<number> {
    return toNumber(await this.simulateView("decimals", []));
  }

  /** Latest reserve attestation IPFS hash, if any. */
  async getReserveAttestation(): Promise<string | null> {
    const value = await this.simulateView("reserve_attestation", []);
    return value == null ? null : toString(value);
  }

  // ── Write methods ─────────────────────────────────────────────────────────

  /** Transfer tokens from `from` to `to` (`from` signs via `sourceKeypair`). */
  async transfer(args: {
    from: string;
    to: string;
    amount: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [
        this.addressArg(args.from),
        this.addressArg(args.to),
        this.i128Arg(args.amount),
      ],
      args.sourceKeypair,
      "transfer"
    );
  }

  /** Mint tokens (minter role required). */
  async mint(args: {
    to: string;
    amount: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.to), this.i128Arg(args.amount)],
      args.sourceKeypair,
      "mint"
    );
  }

  /** Burn tokens (minter role required). */
  async burn(args: {
    from: string;
    amount: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.from), this.i128Arg(args.amount)],
      args.sourceKeypair,
      "burn"
    );
  }

  /** Approve `spender` to transfer up to `amount` on behalf of `from`. */
  async approve(args: {
    from: string;
    spender: string;
    amount: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [
        this.addressArg(args.from),
        this.addressArg(args.spender),
        this.i128Arg(args.amount),
      ],
      args.sourceKeypair,
      "approve"
    );
  }

  /** Transfer tokens using a granted allowance (spender signs). */
  async transferFrom(args: {
    spender: string;
    from: string;
    to: string;
    amount: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [
        this.addressArg(args.spender),
        this.addressArg(args.from),
        this.addressArg(args.to),
        this.i128Arg(args.amount),
      ],
      args.sourceKeypair,
      "transfer_from"
    );
  }

  /** Pause all transfers (pauser role required). */
  async pause(sourceKeypair: Keypair): Promise<SubmitResult> {
    return this.invokeWrite([], sourceKeypair, "pause");
  }

  /** Resume operations (pauser role required). */
  async unpause(sourceKeypair: Keypair): Promise<SubmitResult> {
    return this.invokeWrite([], sourceKeypair, "unpause");
  }

  /** Add `account` to the blocklist (blocklister role required). */
  async blocklist(args: {
    account: string;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.account)],
      args.sourceKeypair,
      "blocklist"
    );
  }

  /** Remove `account` from the blocklist (blocklister role required). */
  async unblocklist(args: {
    account: string;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.account)],
      args.sourceKeypair,
      "unblocklist"
    );
  }

  /** Force-revoke tokens from `from` (admin role required). */
  async clawback(args: {
    from: string;
    amount: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.from), this.i128Arg(args.amount)],
      args.sourceKeypair,
      "clawback"
    );
  }

  /** Update the on-chain IPFS CID of the reserve attestation (admin). */
  async setReserveAttestation(args: {
    hash: string;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [nativeToScVal(args.hash, { type: "string" })],
      args.sourceKeypair,
      "set_reserve_attestation"
    );
  }

  // ── Two-step admin handover ───────────────────────────────────────────────

  /**
   * Step 1 of the admin handover. The **current** admin proposes a
   * successor. The successor must separately {@link acceptAdmin} before
   * the role change takes effect.
   */
  async proposeAdmin(args: {
    newAdmin: string;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.newAdmin)],
      args.sourceKeypair,
      "propose_admin"
    );
  }

  /**
   * Step 2 of the admin handover. The **proposed** successor calls this
   * to take on the admin role. Auth is required from the proposed address.
   */
  async acceptAdmin(sourceKeypair: Keypair): Promise<SubmitResult> {
    return this.invokeWrite([], sourceKeypair, "accept_admin");
  }

  /**
   * The **current** admin can withdraw a pending proposal. Useful when the
   * originally proposed successor is no longer capable (e.g. lost keys,
   * wrong address).
   */
  async cancelProposedAdmin(sourceKeypair: Keypair): Promise<SubmitResult> {
    return this.invokeWrite([], sourceKeypair, "cancel_proposed_admin");
  }

  /** Current pending admin proposal, if any.
   * Returns `null` when no proposal is in flight, otherwise the proposed
   * successor's G-address. */
  async getPendingAdmin(): Promise<string | null> {
    const value = await this.simulateView("pending_admin", []);
    return value == null ? null : toString(value);
  }

  // ── Velocity Limits (MiCAR Art. 46) ────────────────────────────────────

  /** Set the global default 24h outgoing-volume cap (admin). `0n` disables
   * capping. Addresses without a per-address override use this limit. */
  async setGlobalVelocityLimit(args: {
    limit: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.i128Arg(args.limit)],
      args.sourceKeypair,
      "set_global_velocity_limit"
    );
  }

  /** Set a per-address override (admin). `0n` makes the address unlimited
   * regardless of the global default. Use {@link clearVelocityLimit} to
   * restore the global fallback. */
  async setVelocityLimit(args: {
    address: string;
    limit: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.address), this.i128Arg(args.limit)],
      args.sourceKeypair,
      "set_velocity_limit"
    );
  }

  /** Clear a per-address override, falling back to the global default (admin). */
  async clearVelocityLimit(args: {
    address: string;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.addressArg(args.address)],
      args.sourceKeypair,
      "clear_velocity_limit"
    );
  }

  /** Effective 24h velocity limit for `address` (per-address override
   * takes precedence). `0n` means unlimited. */
  async getVelocityLimit(address: string): Promise<bigint> {
    return toBigInt(
      await this.simulateView("get_velocity_limit", [this.addressArg(address)])
    );
  }

  /** Currently-accumulated outgoing volume in the 24h sliding window.
   * Useful to surface "you can transfer at most X more today" before
   * attempting a transfer that the contract would reject for velocity. */
  async getOutflowToday(address: string): Promise<bigint> {
    return toBigInt(
      await this.simulateView("get_outflow_today", [this.addressArg(address)])
    );
  }

  // ── Aggregate Mint Cap (MiCAR Art. 46) ────────────────────────────────────

  /**
   * Set the aggregate supply cap (admin). `0n` disables the cap
   * (unlimited). Panics on-chain if `cap < current_total_supply` —
   * `setAggregateMintCap(0n)` is a safe way to "uncap" without that
   * pre-check, via {@link unsetAggregateMintCap}.
   */
  async setAggregateMintCap(args: {
    cap: bigint;
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite(
      [this.i128Arg(args.cap)],
      args.sourceKeypair,
      "set_aggregate_mint_cap"
    );
  }

  /**
   * Read the current aggregate supply cap. `0n` means "no cap".
   */
  async getAggregateMintCap(): Promise<bigint> {
    return toBigInt(
      await this.simulateView("get_aggregate_mint_cap", [])
    );
  }

  /**
   * Remove the aggregate supply cap (admin). Equivalent to
   * `setAggregateMintCap(0n)` but without the on-chain "cap must be
   * zero or >= current total supply" assertion (which is trivially
   * satisfied when the new cap is 0).
   */
  async unsetAggregateMintCap(args: {
    sourceKeypair: Keypair;
  }): Promise<SubmitResult> {
    return this.invokeWrite([], args.sourceKeypair, "unset_aggregate_mint_cap");
  }

  // ── MiCAR Retention (admin-driven) ───────────────────────────────────────

  /**
   * Batch-extend TTL on every Balance / Allowance / Blocklisted /
   * VelocityLimit / VelocityState entry to the host ceiling
   * (`max_entry_ttl` = 6_312_000 ledgers ≈ 1 year at ~5 s/ledger).
   * Required by MiCAR Art. 23 / Art. 48 for 5-year record retention
   * — the host ceiling is 1 year per call, so the calling cron must
   * invoke this periodically (and rely on the per-write TTL bump in
   * `write_balance` / `write_allowance` / `write_blocklist` between
   * calls). Pausable state is intentionally NOT consulted so the
   * entry can run during recovery.
   *
   * Admin only.
   *
   * @returns A {@link SubmitResult} augmented with
   *   `result: TtlExtendResult` — i.e. the standard `{ hash, result, status }`
   *   wrapper where `result` is the contract-side `TtlExtendResult`
   *   struct (`{ addresses_touched: number, allowance_pairs_touched: number }`).
   */
  async extendStorageTtl(args: {
    sourceKeypair: Keypair;
  }): Promise<SubmitResult & { result: TtlExtendResult }> {
    return this.invokeWrite(
      [],
      args.sourceKeypair,
      "extend_storage_ttl"
    ) as Promise<SubmitResult & { result: TtlExtendResult }>;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Call a read-only (view) function via simulation. No transaction is
   * submitted. The source account is a random keypair — funding isn't
   * required because simulation only consumes compute on the RPC.
   */
  private async simulateView(
    method: string,
    args: ReturnType<typeof nativeToScVal>[]
  ): Promise<unknown> {
    try {
      const op = this.contract.call(method, ...args);
      const source = new Account(Keypair.random().publicKey(), "0");
      const tx = new TransactionBuilder(source, {
        fee: this.baseFee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const result = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      if (!result.result) {
        throw new Error("Simulation succeeded with no return value");
      }
      return scValToNative(result.result.retval);
    } catch (err) {
      throw new EmtClientError(
        `view call "${method}" failed: ${(err as Error).message}`,
        err
      );
    }
  }

  /**
   * Build → simulate → `SorobanRpc.assembleTransaction` (which returns a
   * `TransactionBuilder` with footprint + resource fee pre-applied) →
   * `build()` → sign → submit → poll `getTransaction` until confirmed.
   */
  private async invokeWrite(
    args: ReturnType<typeof nativeToScVal>[],
    sourceKeypair: Keypair,
    method: string
  ): Promise<SubmitResult> {
    try {
      // `simulateView` works because it doesn't need a funded source;
      // writes do, so always fetch the real source account.
      const source = await this.server.getAccount(sourceKeypair.publicKey());
      const op = this.contract.call(method, ...args);
      const tx = new TransactionBuilder(source, {
        fee: this.baseFee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error(
          `simulation for "${method}" failed: ${
            (sim as { error?: string }).error ?? JSON.stringify(sim)
          }`
        );
      }

      // `assembleTransaction` returns a TransactionBuilder pre-loaded
      // with footprint & minimum resource fee. `.build()` turns it into
      // an actual Transaction we can sign and submit.
      const preparedBuilder = SorobanRpc.assembleTransaction(tx, sim);
      const prepared = preparedBuilder.build();
      prepared.sign(sourceKeypair);

      const sendRes = await this.server.sendTransaction(prepared);
      const hash = sendRes.hash;
      if (sendRes.status !== "PENDING") {
        throw new Error(
          `sendTransaction returned unexpected status: ${sendRes.status}`
        );
      }

      // Poll until the transaction is included in a ledger, accepted, or
      // definitively fails. `getTransaction` returns NOT_FOUND while the
      // ledger hasn't seen it yet.
      let final: SorobanRpc.Api.GetTransactionResponse | undefined;
      const maxWaitMs = 30_000;
      const pollIntervalMs = 1_000;
      const pollStart = Date.now();
      while (
        final === undefined ||
        final.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND
      ) {
        if (Date.now() - pollStart > maxWaitMs) {
          throw new Error(`timed out waiting for transaction ${hash}`);
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        final = await this.server.getTransaction(hash);
      }

      if (final.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        // Cast inline to a single object shape carrying the optional
        // `result.retval` of type `xdr.ScVal`. Inline avoids an `Extract`
        // type that may collapse to `never` depending on how the SDK
        // exposes its `GetTransactionStatus` enum.
        const retval = (final as unknown as {
          result?: { retval?: xdr.ScVal };
        }).result?.retval;
        return {
          hash,
          result: retval ? scValToNative(retval) : undefined,
          status: final.status,
        };
      }

      throw new Error(
        `transaction ${hash} ended in status ${final.status}: ${JSON.stringify(final)}`
      );
    } catch (err) {
      throw new EmtClientError(
        `write call "${method}" failed: ${(err as Error).message}`,
        err
      );
    }
  }

  private addressArg(addr: string): ReturnType<typeof nativeToScVal> {
    return nativeToScVal(Address.fromString(addr), { type: "address" });
  }

  private i128Arg(value: bigint): ReturnType<typeof nativeToScVal> {
    return nativeToScVal(value, { type: "i128" });
  }
}

// Re-export Networks so consumers don't need a direct dependency on the SDK.
export { Networks };
