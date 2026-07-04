/**
 * Transaction limits provider interface + mock implementation.
 *
 * In production this would read the per-address 24h volume cap from
 * the on-chain `emt_token` contract (via getVelocityLimit) and
 * accumulate it against the current 24h window. The mock uses a
 * hard-coded cap.
 *
 * See docs/sep0008-hook.md §6 for the interface contract.
 */

export interface LimitsProvider {
  /**
   * Returns `true` if the per-address 24h outgoing volume plus
   * `additionalAmount` would exceed the configured cap for `address`.
   */
  wouldExceed(address: string, additionalAmount: bigint): Promise<boolean>;
}

export class MockLimitsProvider implements LimitsProvider {
  /** Hard-coded per-tx cap of 10 EUREMT (100_000_000 with 7 dp). */
  private readonly perTxCap = 100_000_000n;

  async wouldExceed(_address: string, additionalAmount: bigint): Promise<boolean> {
    return additionalAmount > this.perTxCap;
  }
}
