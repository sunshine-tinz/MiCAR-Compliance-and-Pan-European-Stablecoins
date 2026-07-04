/**
 * Shared types for the hook server.
 *
 * These match the JSON shapes documented in docs/sep0008-hook.md §2.
 * Wallets branch on `status` for the high-level outcome, and on
 * `error_code` (when present) for the specific failure mode.
 */

export type DecisionStatus =
  | "approved"
  | "rejected"
  | "pending"
  | "invalid"
  | "error";

export type ErrorCode =
  | "KYC_REQUIRED"
  | "KYC_FAILED"
  | "SANCTIONS_HIT"
  | "BLOCKLIST_HIT"
  | "VELOCITY_EXCEEDED"
  | "TRAVEL_RULE_MISSING"
  | "INVALID_TX"
  | "INTERNAL_ERROR"
  | "RATE_LIMITED";

/** Request body for POST /tx-approve. */
export interface TxApproveRequest {
  /** Base64-encoded transaction envelope XDR. */
  tx: string;
  /** Optional originator (sender) travel-rule data. */
  originator?: TravelRuleParty;
  /** Optional beneficiary (receiver) travel-rule data. */
  beneficiary?: TravelRuleParty;
}

/** Successful approval. */
export interface TxApproveResponseApproved {
  status: "approved";
  /** Base64-encoded SIGNED transaction envelope XDR. */
  tx: string;
  /** Ledger sequence at which the on-chain approval will expire. */
  expires_at_ledger: number;
}

/** Pending (KYC required, etc.). */
export interface TxApproveResponsePending {
  status: "pending";
  error: string;
  /** URL the user must visit to complete the action (e.g. KYC). */
  action_required: string;
}

/** Rejection (sanctions, velocity, etc.). */
export interface TxApproveResponseRejected {
  status: "rejected";
  error_code: ErrorCode;
  error: string;
  details?: Record<string, unknown>;
}

/** Invalid request shape. */
export interface TxApproveResponseInvalid {
  status: "invalid";
  error_code: "INVALID_TX";
  error: string;
}

/** Internal error. */
export interface TxApproveResponseError {
  status: "error";
  error_code: "INTERNAL_ERROR";
  error: string;
}

export type TxApproveResponse =
  | TxApproveResponseApproved
  | TxApproveResponsePending
  | TxApproveResponseRejected
  | TxApproveResponseInvalid
  | TxApproveResponseError;

export interface TravelRuleParty {
  name: string;
  address: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** ISO 8601 date, natural persons only. */
  dob?: string;
  id_number?: string;
}
