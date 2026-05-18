/**
 * EMT Token SDK Client
 *
 * Wraps the Soroban EMT token contract with a typed TypeScript interface.
 *
 * ## Usage
 * ```ts
 * import { EmtClient } from "@eur-emt/sdk";
 *
 * const client = new EmtClient({
 *   contractId: "C...",
 *   networkPassphrase: Networks.TESTNET,
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 * });
 *
 * const balance = await client.balance("G...");
 * ```
 *
 * ## TODO for Contributors
 * - [ ] Add `transfer` method with SEP-0008 hook pre-flight
 * - [ ] Add `mint` and `burn` methods
 * - [ ] Add `blocklist` / `unblocklist` admin methods
 * - [ ] Add `pause` / `unpause` admin methods
 * - [ ] Add event subscription helpers (listen for MINT, BURN, TRANSFER events)
 * - [ ] Add retry logic for RPC failures
 * - [ ] Write unit tests with a mock Soroban RPC server
 */

import {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";

export interface EmtClientConfig {
  contractId: string;
  networkPassphrase: string;
  rpcUrl: string;
}

export class EmtClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private config: EmtClientConfig;

  constructor(config: EmtClientConfig) {
    this.config = config;
    this.contract = new Contract(config.contractId);
    this.server = new SorobanRpc.Server(config.rpcUrl);
  }

  /**
   * Get the token balance of an address.
   * Returns balance in the token's smallest unit (7 decimal places).
   */
  async balance(address: string): Promise<bigint> {
    const account = await this.server.getAccount(address);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "balance",
          nativeToScVal(Address.fromString(address), { type: "address" })
        )
      )
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(result.result!.retval) as bigint;
  }

  /**
   * Get the total token supply.
   */
  async totalSupply(callerAddress: string): Promise<bigint> {
    const account = await this.server.getAccount(callerAddress);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("total_supply"))
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(result.result!.retval) as bigint;
  }

  /**
   * Check whether the contract is paused.
   */
  async isPaused(callerAddress: string): Promise<boolean> {
    const account = await this.server.getAccount(callerAddress);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call("is_paused"))
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(result.result!.retval) as boolean;
  }

  // TODO: implement transfer(), mint(), burn(), pause(), blocklist(), etc.
  // Each method should:
  // 1. Build the transaction
  // 2. Simulate to get the footprint
  // 3. Sign with the provided keypair
  // 4. Submit and wait for confirmation
  // 5. Return the transaction hash
}

export { Networks };
