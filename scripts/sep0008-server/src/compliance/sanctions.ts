/**
 * Sanctions provider interface + implementations.
 *
 *  - `MockSanctionsProvider` — default, in-process, used in
 *    dev/test (`MOCK_MODE=1`). Returns a hit for any address
 *    starting with `GSANCTIONED`.
 *
 *  - `HttpSanctionsProvider` — production, used when `MOCK_MODE=0`
 *    and `SANCTIONS_PROVIDER_URL` + `SANCTIONS_PROVIDER_API_KEY`
 *    are configured. POSTs the address to `{url}/sanctions/screen`
 *    and parses a vendor-neutral JSON response (see
 *    {@link RawSanctionsResponse}).
 *
 * See docs/sep0008-hook.md §6 for the interface contract; the JSON
 * response shape lives in §6.2.
 */

import { HttpProviderError, postJson } from "../common/http";

export type SanctionsHit = {
  list: "EU_CFSP" | "OFAC_SDN" | "UN_CONS" | "UK_HMT" | string;
  matched_field: "address" | "name";
  matched_value: string;
};

export interface SanctionsProvider {
  hit(address: string): Promise<SanctionsHit | null>;
}

// ── Mock (default; in-process) ─────────────────────────────────────────────────

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

// ── Real (HTTP; used when MOCK_MODE=0) ─────────────────────────────────────────

export interface HttpSanctionsProviderConfig {
  /** Provider base URL (e.g. `https://api.chainalysis.com`). */
  url: string;
  /** Bearer token sent in `Authorization: Bearer <token>`. */
  apiKey: string;
  /** Request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number;
}

/**
 * Vendor-neutral JSON response shape accepted by
 * {@link HttpSanctionsProvider}.
 *
 * `hit:false` (or no `hit` field at all) → no match.
 * `hit:true` with `list` + `matched_field` + `matched_value` →
 * surfaced to the handler as a `SANCTIONS_HIT` rejection.
 */
export interface RawSanctionsResponse {
  hit?: boolean;
  list?: "EU_CFSP" | "OFAC_SDN" | "UN_CONS" | "UK_HMT" | string;
  matched_field?: "address" | "name";
  matched_value?: string;
}

export class HttpSanctionsProvider implements SanctionsProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: HttpSanctionsProviderConfig) {
    // Constructor-time config mistakes are NOT network errors — they
    // never reached the wire. Use a plain Error so observability
    // dashboards filtering on `HttpProviderError.code === "network"`
    // don't get a false positive on a misconfigured boot.
    if (!config.url) throw new Error("HttpSanctionsProvider: url is required");
    if (!config.apiKey)
      throw new Error("HttpSanctionsProvider: apiKey is required");
    this.endpoint = config.url.replace(/\/+$/, "") + "/sanctions/screen";
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  async hit(address: string): Promise<SanctionsHit | null> {
    let raw: RawSanctionsResponse;
    try {
      raw = await postJson<RawSanctionsResponse>({
        url: this.endpoint,
        apiKey: this.apiKey,
        timeoutMs: this.timeoutMs,
        body: { address },
      });
    } catch (err) {
      if (err instanceof HttpProviderError) {
        throw new HttpProviderError(
          err.code,
          `sanctions provider: ${err.message}`,
          err.cause,
          err.status,
          err.statusText
        );
      }
      throw err;
    }
    return mapSanctionsResponse(raw);
  }
}

/**
 * Map the vendor-neutral JSON shape into the {@link SanctionsHit}
 * domain type (or `null` for a clear). Throws `"malformed"`-coded
 * {@link HttpProviderError} on a response that claims a hit but is
 * missing the field detail — fail-closed under MiCAR Art. 23: do
 * not silently coerce an incomplete hit into a clear when the
 * provider's verdict is "match found, details missing".
 */
export function mapSanctionsResponse(
  raw: Partial<RawSanctionsResponse>
): SanctionsHit | null {
  if (!raw.hit) return null;
  if (!raw.list || !raw.matched_field || !raw.matched_value) {
    throw new HttpProviderError(
      "malformed",
      `sanctions provider: hit response missing list / matched_field / matched_value`
    );
  }
  return {
    list: raw.list,
    matched_field: raw.matched_field,
    matched_value: raw.matched_value,
  };
}
