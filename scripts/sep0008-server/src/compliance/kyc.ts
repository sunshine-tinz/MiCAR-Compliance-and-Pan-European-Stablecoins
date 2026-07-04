/**
 * KYC provider interface + mock implementation.
 *
 * In production this would wrap a real provider (Jumio, Onfido,
 * Sumsub, etc.). The mock returns canned responses so the server
 * boots and tests run without external credentials.
 *
 * See docs/sep0008-hook.md §6 for the interface contract.
 */

export type KycStatus =
  | { kind: "verified"; level: "basic" | "enhanced" }
  | { kind: "pending"; action_url: string }
  | { kind: "failed"; reason: string }
  | { kind: "unknown" };

export interface KycProvider {
  status(address: string): Promise<KycStatus>;
}

export class MockKycProvider implements KycProvider {
  async status(address: string): Promise<KycStatus> {
    // Addresses starting with "GVERIFIED" are pre-cleared; everything
    // else needs to complete KYC. Adjust these heuristics to exercise
    // different paths in development.
    if (address.startsWith("GVERIFIED")) {
      return { kind: "verified", level: "enhanced" };
    }
    if (address.startsWith("GFAILED")) {
      return { kind: "failed", reason: "mock: synthetic failure" };
    }
    return {
      kind: "pending",
      action_url: "https://kyc.example.com/verify?ref=" + address,
    };
  }
}
