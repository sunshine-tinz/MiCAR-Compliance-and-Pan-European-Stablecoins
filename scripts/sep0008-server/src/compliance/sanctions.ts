/**
 * Sanctions provider interface + mock implementation.
 *
 * In production this would wrap a real sanctions list API
 * (Chainalysis, Elliptic, ComplyAdvantage, etc.). The mock returns
 * canned responses so the server boots and tests run without external
 * credentials.
 *
 * See docs/sep0008-hook.md §6 for the interface contract.
 */

export type SanctionsHit = {
  list: "EU_CFSP" | "OFAC_SDN" | "UN_CONS" | "UK_HMT" | string;
  matched_field: "address" | "name";
  matched_value: string;
};

export interface SanctionsProvider {
  hit(address: string): Promise<SanctionsHit | null>;
}

export class MockSanctionsProvider implements SanctionsProvider {
  async hit(address: string): Promise<SanctionsHit | null> {
    if (address.startsWith("GSANCTIONED")) {
      return {
        list: "EU_CFSP",
        matched_field: "address",
        matched_value: address,
      };
    }
    return null;
  }
}
