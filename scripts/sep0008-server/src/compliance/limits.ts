/**
 * Transaction limits provider interface + implementations.
 *
 * Two implementations are wired in by {@link src/index.ts}:
 *
 *  - `MockLimitsProvider` — default, used when `MOCK_MODE=1`. Returns
 *    mocked cap-state based on an in-memory per-address ledger so
 *    tests can exercise the rejection path without a live chain.
 *
 *  - `EmtTokenLimitsProvider` — production, used when `MOCK_MODE=0`.
 *    Calls `emt_token.get_velocity_limit(addr)` and
 *    `emt_token.get_outflow_today(addr)` via the Soroban RPC and
 *    computes `cur + additionalAmount > effectiveLimit`.
 *
 * See docs/sep0008-hook.md §6 for the interface contract.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  scValToNative,
  SorobanRpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface LimitsProvider {
  /**
   * Returns `true` if the per-address 24h outgoing volume plus
   * `additionalAmount` would exceed the configured cap for `address`.
   */
  wouldExceed(address: string, additionalAmount: bigint): Promise<boolean>;
}

// ── Mock (default; in-process) ─────────────────────────────────────────────────

export interface MockLimitsProviderOptions {
  /**
   * If true, every `wouldExceed` call returns `true` regardless of
   * amount. Lets tests exercise the `VELOCITY_EXCEEDED` rejection
   * path without depending on hard-coded cap semantics.
   * **Wins over `perAddressLimit: 0n` (unlimited)** — use sparsely
   * and only for fixture-driven rejection tests; a production-shaped
   * mock should pass `perAddressLimit` + `currentOutflow` instead.
   */
  forceExceed?: boolean;

  /**
   * Per-address curent 24h outgoing volume (smallest unit, e.g. 7 dp
   * EUREMT). Combined with `perAddressLimit` (or the default `perTxCap`
   * fallback when no override is set for that address) to compute the
   * real rejection path.
   */
  currentOutflow?: Map<string, bigint>;

  /**
   * Per-address effective limit (smallest unit, e.g. 7 dp EUREMT).
   * Overrides the `perTxCap` default for matched addresses. `0n` means
   * unlimited for that address.
   */
  perAddressLimit?: Map<string, bigint>;

  /**
   * Default per-tx cap (smallest unit; `0n` disables the default and
   * introduces an "everyone is unlimited unless overridden" semantic).
   * Defaults to `100_000_000n` (10 EUREMT at 7 dp), matching the
   * spec-shaped placeholder that shipped before the chain-read wiring.
   */
  perTxCap?: bigint;
}

export class MockLimitsProvider implements LimitsProvider {
  private readonly perTxCap: bigint;
  private readonly forceExceed: boolean;
  private readonly currentOutflow: Map<string, bigint>;
  private readonly perAddressLimit: Map<string, bigint>;

  constructor(opts: MockLimitsProviderOptions = {}) {
    this.perTxCap = opts.perTxCap ?? 100_000_000n;
    this.forceExceed = opts.forceExceed ?? false;
    this.currentOutflow = opts.currentOutflow ?? new Map();
    this.perAddressLimit = opts.perAddressLimit ?? new Map();
  }

  async wouldExceed(address: string, additionalAmount: bigint): Promise<boolean> {
    if (this.forceExceed) return true;
    // 0 caps = unlimited (mirrors the `0 = no limit` sentinel on chain).
    const override = this.perAddressLimit.get(address);
    if (override !== undefined && override === 0n) return false;
    const effective = override ?? this.perTxCap;
    if (effective === 0n) return false;
    const cur = this.currentOutflow.get(address) ?? 0n;
    return cur + additionalAmount > effective;
  }
}

// ── Real (Soroban RPC; used when MOCK_MODE=0) ──────────────────────────────────

export interface EmtTokenLimitsProviderConfig {
  /** Soroban RPC URL (e.g. `https://soroban-testnet.stellar.org`). */
  rpcUrl: string;
  /** Deployed `emt_token` contract ID (`C...`). */
  contractId: string;
  /** Network passphrase (e.g. `Networks.TESTNET`). */
  networkPassphrase: string;
}

/**
 * Production limits provider.
 *
 * Reads the per-address effective 24h limit
 * (`emt_token.get_velocity_limit(addr)`) and the current 24h
 * accumulated outgoing volume (`emt_token.get_outflow_today(addr)`),
 * both via Soroban RPC `simulateTransaction`. Returns `true` when the
 * projected volume (`current + additionalAmount`) exceeds the limit.
 *
 * Following the on-chain convention: a `0n` limit means unlimited for
 * this address — the provider returns `false` without making a
 * second RPC call (the host CPU cost of a useless check would be
 * wasted otherwise).
 */
export class EmtTokenLimitsProvider implements LimitsProvider {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  // Reuse one funded-free source account across reads — funding isn't
  // required for simulation, and constructing a fresh Account on every
  // call would dominate the latency budget.
  private readonly source: Account;

  constructor(config: EmtTokenLimitsProviderConfig) {
    if (!config.rpcUrl) throw new Error("EmtTokenLimitsProvider: rpcUrl is required");
    if (!config.contractId)
      throw new Error("EmtTokenLimitsProvider: contractId is required");
    if (!config.networkPassphrase)
      throw new Error(
        "EmtTokenLimitsProvider: networkPassphrase is required"
      );

    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.contract = new Contract(config.contractId);
    this.networkPassphrase = config.networkPassphrase;
    this.source = new Account(Keypair.random().publicKey(), "0");
  }

  async wouldExceed(address: string, additionalAmount: bigint): Promise<boolean> {
    const limit = await this.callI128("get_velocity_limit", address);
    // 0 = unlimited (matches `effective_velocity_limit` on chain).
    if (limit === 0n) return false;
    const cur = await this.callI128("get_outflow_today", address);
    return cur + additionalAmount > limit;
  }

  /** Simulate a single i128-returning view call; coerce the retval. */
  private async callI128(method: string, address: string): Promise<bigint> {
    const op = this.contract.call(method, addressArg(address));
    const tx = new TransactionBuilder(this.source, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`${method} simulation failed: ${sim.error}`);
    }
    if (!sim.result || !sim.result.retval) {
      throw new Error(`${method} returned no value`);
    }
    const native = scValToNative(sim.result.retval);
    return toBigInt(native);
  }
}

function addressArg(addr: string) {
  return nativeToScVal(Address.fromString(addr), { type: "address" });
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  return BigInt(String(v));
}
