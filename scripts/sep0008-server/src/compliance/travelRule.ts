/**
 * Travel-rule provider interface + mock implementation.
 *
 * MiCAR Art. 22 (mirroring FATF Rec. 16) requires originator +
 * beneficiary data for transfers above a threshold. The mock uses
 * a hard-coded threshold and just checks whether the fields are
 * present.
 *
 * See docs/sep0008-hook.md §6 for the interface contract.
 */

import type { TravelRuleParty } from "../types";

export interface TravelRuleProvider {
  /**
   * Returns `null` if the transfer is below the threshold or the
   * supplied originator/beneficiary data is sufficient. Returns a
   * description of the missing fields otherwise.
   */
  missingData(
    amount: bigint,
    originator?: TravelRuleParty,
    beneficiary?: TravelRuleParty
  ): Promise<string | null>;
}

export class MockTravelRuleProvider implements TravelRuleProvider {
  /** Threshold: 100 EUREMT (1_000_000_000 with 7 dp) — for skeleton
   * testing; production should be 1,000 EUR per FATF Rec. 16. */
  private readonly threshold = 1_000_000_000n;

  async missingData(
    amount: bigint,
    originator?: TravelRuleParty,
    beneficiary?: TravelRuleParty
  ): Promise<string | null> {
    if (amount < this.threshold) return null;
    const missing: string[] = [];
    if (!originator) missing.push("originator");
    else {
      if (!originator.name) missing.push("originator.name");
      if (!originator.address) missing.push("originator.address");
      if (!originator.country) missing.push("originator.country");
    }
    if (!beneficiary) missing.push("beneficiary");
    else {
      if (!beneficiary.name) missing.push("beneficiary.name");
      if (!beneficiary.address) missing.push("beneficiary.address");
      if (!beneficiary.country) missing.push("beneficiary.country");
    }
    return missing.length === 0 ? null : missing.join(", ");
  }
}
