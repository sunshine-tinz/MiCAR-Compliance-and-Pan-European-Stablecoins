# SEP-0008 Compliance Hook Server — Specification

This document is the full specification for the off-chain **SEP-0008
compliance hook server** that pairs with the on-chain
[`compliance_hook`](../contracts/compliance_hook/src/lib.rs) contract. It
covers the protocol flow, the HTTP API, the error code catalog, the
auth model, the deployment topology, the provider interfaces, the
environment variables, and the on-chain integration.

The reference implementation lives at
[`scripts/sep0008-server/`](../scripts/sep0008-server/) and is built
against this spec — when the two diverge, **this document is the
source of truth**.

## 1. Protocol flow

```
┌─────────────┐                              ┌─────────────────┐                ┌──────────────────┐
│  Wallet /   │   POST /tx-approve (XDR)    │   Hook server   │  Stellar RPC  │   Soroban        │
│  Exchange   │ ─────────────────────────►  │  (this spec)    │ ────────────► │   compliance_    │
│             │ ◄─────────────────────────  │                 │               │   hook + emt_    │
│             │   200 (signed XDR)          │                 │               │   token          │
│             │   400 (rejected)            │                 │               │                  │
└─────────────┘   200 (pending + URL)       └─────────────────┘                └──────────────────┘
                                                │
                                                │  provider calls
                                                ▼
                                       ┌─────────────────┐
                                       │  KYC            │
                                       │  Sanctions      │
                                       │  Travel-rule    │
                                       └─────────────────┘
```

The wallet builds a Stellar transaction, sends the XDR to the hook
server, the server screens it (KYC, sanctions, limits, travel-rule)
against off-chain providers, and either co-signs the transaction and
returns it (approve), returns a structured rejection (reject), or
returns a "pending" response with a URL the user must visit (e.g., to
complete KYC).

The wallet then submits the signed transaction to Stellar, where
Soroban runs it through the token contract's normal authorization
checks plus (optionally) a read against the `compliance_hook` contract
to confirm the server approved the corresponding tx hash.

## 2. HTTP API

All endpoints accept and return JSON unless noted. The base path is
unversioned (this is a single-instance service, not a multi-version
platform). Content-Type: `application/json; charset=utf-8`.

### 2.1. `POST /tx-approve`

The primary endpoint. Approves, rejects, or asks for more info about
a transaction.

**Request body**

```json
{
  "tx": "AAAAGQAAAA…(base64 transaction envelope XDR)…AAA="
}
```

**Success response — HTTP 200**

```json
{
  "status": "approved",
  "tx": "AAAAGQAAAA…(base64 SIGNED transaction envelope XDR)…AAA=",
  "expires_at_ledger": 12345678
}
```

The wallet should submit the signed `tx` to Stellar before
`expires_at_ledger` (the on-chain `compliance_hook` rejects approvals
past `APPROVAL_TTL_LEDGERS`).

**Pending response — HTTP 200**

```json
{
  "status": "pending",
  "error": "KYC verification required",
  "action_required": "https://kyc.example.com/verify?ref=abc123"
}
```

The wallet surfaces `action_required` to the user. Once the user
completes the action, the wallet re-submits the transaction.

**Rejection response — HTTP 400**

```json
{
  "status": "rejected",
  "error_code": "SANCTIONS_HIT",
  "error": "Sender GABC… is on the EU sanctions list",
  "details": {
    "list": "EU_CFSP",
    "matched_field": "address"
  }
}
```

The wallet must surface `error` to the user and **not** submit the
transaction to Stellar.

**Invalid request — HTTP 400**

```json
{
  "status": "invalid",
  "error_code": "INVALID_TX",
  "error": "XDR could not be decoded as a TransactionEnvelope"
}
```

**Internal error — HTTP 500**

```json
{
  "status": "error",
  "error_code": "INTERNAL_ERROR",
  "error": "Provider call timed out; please retry"
}
```

### 2.2. `GET /health`

Liveness probe. Returns 200 if the process is up and the HTTP server
is accepting connections. **Does not** check provider connectivity.

**Response — HTTP 200**

```json
{ "status": "ok", "uptime_s": 12345 }
```

### 2.3. `GET /ready`

Readiness probe. Returns 200 if the process can serve requests (all
configured providers are reachable, the on-chain RPC URL responds, the
signer key is loaded). Returns 503 otherwise.

**Response — HTTP 200**

```json
{
  "status": "ready",
  "providers": {
    "kyc": "ok",
    "sanctions": "ok",
    "travel_rule": "ok",
    "onchain_rpc": "ok"
  }
}
```

**Response — HTTP 503**

```json
{
  "status": "not_ready",
  "providers": {
    "kyc": "ok",
    "sanctions": "degraded",
    "travel_rule": "down",
    "onchain_rpc": "ok"
  }
}
```

### 2.4. `GET /status/:txHash`

Lookup the previous decision for `txHash` (the base64 SHA-256 of the
unsigned transaction envelope). Useful for ops debugging and
compliance reconciliation.

**Response — HTTP 200**

```json
{
  "tx_hash": "abc123…",
  "decision": "approved",
  "decided_at": "2026-07-04T18:18:13Z",
  "expires_at_ledger": 12345678
}
```

**Response — HTTP 404**

```json
{
  "error": "no decision recorded for this tx hash"
}
```

## 3. Error code catalog

All errors use a stable **string code** in `error_code`. Clients
should branch on the code, not the human-readable `error` message.

| Code | HTTP status | Meaning | User action |
|---|---|---|---|
| `KYC_REQUIRED` | 200 (status=pending) | Sender or receiver is not KYC'd | Complete KYC at `action_required` URL, then retry |
| `KYC_FAILED` | 400 (status=rejected) | KYC was performed and failed | Contact support |
| `SANCTIONS_HIT` | 400 (status=rejected) | Address is on a sanctions list (EU CFSP, OFAC, UN, etc.) | None — hard block |
| `BLOCKLIST_HIT` | 400 (status=rejected) | Address is on the on-chain blocklist | None — hard block |
| `VELOCITY_EXCEEDED` | 400 (status=rejected) | Per-address 24h volume cap exceeded | Wait or contact the issuer |
| `TRAVEL_RULE_MISSING` | 400 (status=rejected) | Transfer > €1,000 lacks travel-rule data | Re-submit with `originator` + `beneficiary` fields |
| `INVALID_TX` | 400 (status=invalid) | XDR could not be decoded, or the operation is not a Soroban transfer | Fix the wallet |
| `INTERNAL_ERROR` | 500 (status=error) | Provider timeout, RPC down, signer failure | Retry with exponential backoff |
| `RATE_LIMITED` | 429 | Per-IP or per-account request rate exceeded | Back off and retry |

## 4. Auth model

The hook server authenticates **two classes of callers**:

1. **Wallets / exchanges** calling `POST /tx-approve`. Auth options:
   - **mTLS** (recommended for production) — client cert pinned to a
     known CA bundle.
   - **API key** in the `Authorization: Bearer <key>` header
     (default for the skeleton, for ease of dev / test).

2. **Operators** calling `GET /health`, `GET /ready`, `GET /status/...`.
   These are unauthenticated on the public internet but should be
   fronted by an internal network policy / load balancer. The skeleton
   exposes them without auth and relies on the deployment topology
   for protection.

The server **signs** approved transactions with its own Stellar
keypair (the `HOOK_SERVER_SECRET_KEY` env var). The corresponding
public address is registered in the on-chain `compliance_hook`
contract via `initialize(admin, hook_server_address)`.

## 5. Deployment topology

```
                            ┌──────────────────────────┐
                            │   TLS terminator         │
   Internet (wallets) ────► │   (nginx / cloud LB)    │
                            └────────────┬─────────────┘
                                         │ mTLS or Bearer
                                         ▼
                            ┌──────────────────────────┐
                            │   Hook server (Node)     │
                            │   - Express              │
                            │   - Provider clients     │
                            │   - Stellar signer       │
                            └─────┬────────┬────────┬──┘
                                  │        │        │
                          ┌───────┘        │        └────────┐
                          │                │                 │
                          ▼                ▼                 ▼
                  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
                  │ KYC provider │  │ Sanctions    │  │ Soroban      │
                  │ (HTTP)       │  │ provider     │  │ RPC          │
                  └──────────────┘  │ (HTTP)       │  │ (Horizon/    │
                                     └──────────────┘  │  Soroban RPC)│
                                                       └──────────────┘
```

Production deployment checklist:
- [ ] TLS cert + mTLS CA bundle configured
- [ ] Hook server runs as a systemd unit or k8s deployment behind a
  load balancer
- [ ] `HOOK_SERVER_SECRET_KEY` stored in a secret manager (not in
  the image or env file)
- [ ] Logs shipped to a central aggregator (the server emits
  structured JSON to stdout)
- [ ] `/health` and `/ready` endpoints wired to the LB
- [ ] On-chain `compliance_hook.HookServer` address updated to match
  the production keypair's public address

## 6. Provider interfaces

The server defines TypeScript interfaces for each compliance provider.
Real implementations (Jumio, Chainalysis, etc.) wrap the provider's
HTTP API behind these interfaces. The skeleton ships **mock
implementations** that return canned responses, intended for local
development and integration testing.

```ts
// src/compliance/kyc.ts
export interface KycProvider {
  /** Returns the KYC status of `address`. */
  status(address: string): Promise<KycStatus>;
}

export type KycStatus =
  | { kind: "verified"; level: "basic" | "enhanced" }
  | { kind: "pending"; action_url: string }
  | { kind: "failed"; reason: string }
  | { kind: "unknown" };
```

```ts
// src/compliance/sanctions.ts
export interface SanctionsProvider {
  /** Returns `true` if `address` is on any watch list. */
  hit(address: string): Promise<SanctionsHit | null>;
}

export type SanctionsHit = {
  list: "EU_CFSP" | "OFAC_SDN" | "UN_CONS" | "UK_HMT" | string;
  matched_field: "address" | "name";
  matched_value: string;
};
```

```ts
// src/compliance/limits.ts
export interface LimitsProvider {
  /**
   * Returns `true` if the per-address 24h outgoing volume plus
   * `additionalAmount` would exceed the configured cap for `address`.
   * Reads the cap from the on-chain `emt_token` contract via the RPC
   * client; in MOCK_MODE it uses a hard-coded cap.
   */
  wouldExceed(address: string, additionalAmount: bigint): Promise<boolean>;
}
```

```ts
// src/compliance/travelRule.ts
export interface TravelRuleProvider {
  /**
   * Returns `null` if the transfer is below the €1,000 travel-rule
   * threshold or if the supplied originator/beneficiary data is
   * sufficient. Returns a description of the missing fields otherwise.
   */
  missingData(
    amount: bigint,
    originator?: TravelRuleParty,
    beneficiary?: TravelRuleParty
  ): Promise<string | null>;
}

export type TravelRuleParty = {
  name: string;
  address: string;
  country: string;        // ISO 3166-1 alpha-2
  dob?: string;          // ISO 8601, natural persons only
  id_number?: string;    // national ID / passport
};
```

## 7. Integration with the on-chain `compliance_hook` contract

The on-chain `compliance_hook` contract records the server's
decisions so the contract-level flow can optionally cross-check
approvals. The flow is:

1. Wallet sends transaction XDR to the hook server (`POST /tx-approve`).
2. The server screens it. If approved, the server:
   a. Signs the transaction with `HOOK_SERVER_SECRET_KEY`.
   b. (Optionally) calls `compliance_hook.approve_transaction(tx_hash)`
      to record the approval on chain. The `tx_hash` is the SHA-256
      of the **unsigned** transaction envelope.
3. The server returns the signed XDR to the wallet.
4. The wallet submits the signed transaction to Soroban.
5. (Optionally) the emt_token contract's transfer check reads
   `compliance_hook.is_approved(tx_hash)` and panics if not approved.

Whether step 2b / 5 happens is a policy decision per issuer. Some
issuers keep the hook server purely off-chain (screening + signing)
and let Soroban's normal auth gates be the final word. Others want
the audit trail on chain so the decision is publicly verifiable.

The reference implementation in this repo supports both: the
`compliance_hook` contract is fully implemented, and the emt_token
contract can be extended to call `is_approved` from `transfer()` /
`transfer_from()` (see CONTRIBUTING.md for the open issue).

## 8. Environment variables

The server reads all configuration from environment variables. The
skeleton ships a `scripts/sep0008-server/.env.example` with the full
list. Required vs optional:

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | optional | `3000` | HTTP port |
| `STELLAR_NETWORK` | required | — | `testnet` / `futurenet` / `mainnet` |
| `STELLAR_RPC_URL` | required | — | e.g. `https://soroban-testnet.stellar.org` |
| `STELLAR_NETWORK_PASSPHRASE` | required | — | e.g. `Test SDF Network ; September 2015` |
| `HOOK_SERVER_SECRET_KEY` | required | — | `S...` secret; the public address must match `compliance_hook.HookServer` |
| `EMT_CONTRACT_ID` | required | — | `C...` address of the deployed token |
| `COMPLIANCE_HOOK_CONTRACT_ID` | required | — | `C...` address of the deployed compliance hook (for `approve_transaction` recording) |
| `API_KEY` | required | — | Bearer token wallets present in `Authorization: Bearer <key>` |
| `MOCK_MODE` | optional | `1` | If `1`, use mock KYC / sanctions / travel-rule providers |
| `KYC_PROVIDER_URL` | optional* | — | KYC provider's HTTP base URL |
| `KYC_PROVIDER_API_KEY` | optional* | — | |
| `SANCTIONS_PROVIDER_URL` | optional* | — | Sanctions provider's HTTP base URL |
| `SANCTIONS_PROVIDER_API_KEY` | optional* | — | |
| `TRAVEL_RULE_PROVIDER_URL` | optional* | — | Travel-rule provider's HTTP base URL |
| `TRAVEL_RULE_PROVIDER_API_KEY` | optional* | — | |
| `LOG_LEVEL` | optional | `info` | `debug` / `info` / `warn` / `error` |
| `RATE_LIMIT_PER_MIN` | optional | `60` | Per-IP requests/minute for `POST /tx-approve` |

*Required when `MOCK_MODE=0`.

## 9. Reference

- [SEP-0008 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md)
- [Stellar Regulated Assets Guide](https://developers.stellar.org/docs/tokens/control-asset-access)
- [`scripts/sep0008-server/`](../scripts/sep0008-server/) — reference implementation
- [`contracts/compliance_hook/`](../contracts/compliance_hook/) — on-chain approval ledger
- [`docs/architecture.md`](architecture.md) — system design
- [`docs/micar-compliance.md`](micar-compliance.md) — Art. 22 (travel rule) and Art. 23 (AML/CFT) mapping
