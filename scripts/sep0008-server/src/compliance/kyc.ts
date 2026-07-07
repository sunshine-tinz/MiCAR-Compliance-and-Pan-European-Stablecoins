/**
 * KYC provider interface + implementations.
 *
 *  - `MockKycProvider` — default, in-process, used in dev/test
 *    (`MOCK_MODE=1`). Routes by `address` prefix:
 *      `GVERIFIED*`  → verified
 *      `GFAILED*`    → failed
 *      anything else → pending
 *
 *  - `HttpKycProvider` — production, used when `MOCK_MODE=0` and the
 *    operator configures `KYC_PROVIDER_URL` + `KYC_PROVIDER_API_KEY`
 *    in the environment. POSTs the address to `{url}/kyc/screen` and
 *    parses a vendor-neutral JSON response (see {@link RawKycResponse}).
 *
 * See docs/sep0008-hook.md §6 for the interface contract; the JSON
 * response shape lives in §6.1.
 */

import { HttpProviderError, postJson } from "../common/http";

export type KycStatus =
  | { kind: "verified"; level: "basic" | "enhanced" }
  | { kind: "pending"; action_url: string }
  | { kind: "failed"; reason: string }
  | { kind: "unknown" };

export interface KycProvider {
  status(address: string): Promise<KycStatus>;
}

// ── Mock (default; in-process) ─────────────────────────────────────────────────

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

// ── Real (HTTP; used when MOCK_MODE=0) ─────────────────────────────────────────

export interface HttpKycProviderConfig {
  /** Provider base URL (e.g. `https://api.example.com`). */
  url: string;
  /** Bearer token sent in `Authorization: Bearer <token>`. */
  apiKey: string;
  /** Request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number;
}

/**
 * Vendor-neutral JSON response shape accepted by {@link HttpKycProvider}.
 * The mapping into {@link KycStatus} lives below; if your provider
 * uses different keys, transform them into this shape in a thin
 * adapter class that delegates to `HttpKycProvider`-equivalent logic.
 */
export interface RawKycResponse {
  status: "verified" | "pending" | "failed" | "unknown";
  /** Verified-only: KYC level. Defaulted to `"basic"` if missing. */
  level?: "basic" | "enhanced";
  /** Pending-only: URL the user must visit to complete KYC. Required when status=pending. */
  action_url?: string;
  /** Failed-only: human-readable reason. Defaulted if missing. */
  reason?: string;
}

export class HttpKycProvider implements KycProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: HttpKycProviderConfig) {
    // Constructor-time config mistakes are NOT network errors — they
    // never reached the wire. Use a plain Error so observability
    // dashboards filtering on `HttpProviderError.code === "network"`
    // don't get a false positive on a misconfigured boot.
    if (!config.url) throw new Error("HttpKycProvider: url is required");
    if (!config.apiKey) throw new Error("HttpKycProvider: apiKey is required");
    this.endpoint = config.url.replace(/\/+$/, "") + "/kyc/screen";
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  async status(address: string): Promise<KycStatus> {
    let raw: RawKycResponse;
    try {
      raw = await postJson<RawKycResponse>({
        url: this.endpoint,
        apiKey: this.apiKey,
        timeoutMs: this.timeoutMs,
        body: { address },
      });
    } catch (err) {
      // Re-throw with the same shape so the handler's INTERNAL_ERROR
      // mapping keeps working — only the message gets a KYC-flavored
      // prefix for ops debugging.
      if (err instanceof HttpProviderError) {
        throw new HttpProviderError(
          err.code,
          `kyc provider: ${err.message}`,
          err.cause,
          err.status,
          err.statusText
        );
      }
      throw err;
    }
    return mapKycResponse(raw);
  }
}

/**
 * Map the vendor-neutral JSON shape into the {@link KycStatus} domain
 * type. Throws `"malformed"`-coded {@link HttpProviderError} if the
 * shape is incompatible (e.g. `status=pending` without `action_url`).
 * Fail-closed: a malformed response is treated as a hard provider
 * failure rather than silently coerced to `unknown`, because under
 * MiCAR Art. 23 AML/CFT the operator must KNOW when the screening
 * decision is unavailable — silent coercion would be a compliance
 * fault.
 */
export function mapKycResponse(raw: Partial<RawKycResponse>): KycStatus {
  switch (raw.status) {
    case "verified":
      return { kind: "verified", level: raw.level ?? "basic" };
    case "pending":
      if (!raw.action_url) {
        throw new HttpProviderError(
          "malformed",
          `kyc provider: pending response missing action_url`
        );
      }
      return { kind: "pending", action_url: raw.action_url };
    case "failed":
      return { kind: "failed", reason: raw.reason ?? "rejected by provider" };
    case "unknown":
      return { kind: "unknown" };
    default:
      throw new HttpProviderError(
        "malformed",
        `kyc provider: unknown status "${(raw as { status?: string }).status ?? "<missing>"}"`
      );
  }
}
