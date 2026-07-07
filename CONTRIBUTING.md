# Contributing

Thank you for your interest in contributing to this project. This is an
open-source reference implementation of a MiCAR-compliant Euro EMT on Stellar.

## Prerequisites

- Rust (stable) + `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli)
- Node.js 20+ (for SDK and scripts)
- Basic familiarity with Soroban smart contracts

```bash
# Install Rust wasm target
rustup target add wasm32-unknown-unknown

# Install Stellar CLI
cargo install --locked stellar-cli --features opt

# Install SDK dependencies
cd sdk && npm install
```

## Project Structure

```
contracts/
├── emt_token/          # Core EMT token contract (Rust/Soroban)
├── compliance_hook/    # SEP-0008 on-chain approval record (Rust/Soroban)
└── oracle_interface/   # Reserve attestation oracle (Rust/Soroban)

sdk/
├── src/
│   └── EmtClient.ts    # TypeScript SDK client
└── __tests__/          # Jest unit tests

scripts/
├── deploy.sh           # Build wasm + deploy contracts to testnet/mainnet
├── initialize.sh       # Initialize contract roles after deploy
├── rotate-admin.sh     # One-shot automation for the two-step admin handover
├── verify.sh           # Local CI mirror (fmt + clippy + test + sdk test)
└── sep0008-server/     # Off-chain SEP-0008 compliance hook server
    ├── src/            # Express app, providers, signer, XDR decoder
    ├── test/           # Jest suite (mock-mode integration + unit)
    └── Dockerfile      # Containerised deployment

docs/
├── architecture.md     # System design
├── micar-compliance.md # MiCAR obligations mapping
├── admin-handover.md   # Two-step admin rotation runbook
└── sep0008-hook.md     # Hook server specification
```

## Running Tests

```bash
# Soroban contract tests
cd contracts
cargo test

# SDK tests (once implemented)
cd sdk
npm test
```

## Building Contracts

```bash
cd contracts
cargo build --release --target wasm32-unknown-unknown
```

## Open Issues

Below are the key areas where contributions are needed, roughly ordered by
impact. Shipped checkmarks link the section so contributors don't have
to grep for the contract primitive.

## Shipped

### Contracts (Rust/Soroban)

| Issue | Description | Where |
|---|---|---|
| `approve` / `transfer_from` | ERC-20-style allowance mechanism + delegated transfer | `contracts/emt_token/src/lib.rs` |
| Transfer velocity limits | Per-address 24h two-bucket sliding window (MiCAR Art. 46) | `set_global_velocity_limit` / `set_velocity_limit` / `get_outflow_today` |
| Aggregate mint cap | Hard ceiling on `total_supply` enforced in `mint()` | `set_aggregate_mint_cap` / `unset_aggregate_mint_cap` |
| Two-step admin transfer | `propose_admin` + `accept_admin` + `cancel_proposed_admin` | [`docs/admin-handover.md`](docs/admin-handover.md) |
| 5-year record retention | `extend_storage_ttl` batch-extends every Balance / Allowance / Blocklisted / Velocity entry to the host ceiling | MiCAR Art. 23 / 48 |
| `get_admin` / `pending_admin` views | Off-chain tooling reads state | `get_admin` / `pending_admin` |

### SDK (TypeScript)

| Issue | Description | Where |
|---|---|---|
| `transfer` / `mint` / `burn` / `approve` / `transferFrom` | Build-simulate-sign-submit-poll helpers | `sdk/src/EmtClient.ts` |
| `pause` / `unpause` / `blocklist` / `unblocklist` / `clawback` / `setReserveAttestation` | Admin & compliance operations | `sdk/src/EmtClient.ts` |
| `setGlobalVelocityLimit` / `setVelocityLimit` / `clearVelocityLimit` / `getVelocityLimit` / `getOutflowToday` / `setAggregateMintCap` / `extendStorageTtl` | MiCAR Art. 46 wraps + 5-year retention | MiCAR Art. 46 / 48 |
| SDK tests | Unit tests with mocked Soroban RPC | `sdk/__tests__/EmtClient.test.ts` |

### SEP-0008 Hook Server (Node.js/TypeScript)

| Issue | Description | Where |
|---|---|---|
| Server skeleton | Express + `/health` + `/ready` + `/tx-approve` | `scripts/sep0008-server/src/index.ts` |
| KYC / Sanctions / Travel-rule | Interface + in-process mock providers | `scripts/sep0008-server/src/compliance/` |
| On-chain velocity-limit read | `EmtTokenLimitsProvider` reads `get_velocity_limit` + `get_outflow_today` via Soroban RPC, wired in when `MOCK_MODE=0` | `scripts/sep0008-server/src/compliance/limits.ts` |
| OpenAPI surface | Full HTTP spec in [`docs/sep0008-hook.md`](docs/sep0008-hook.md) §2–§3 | spec document |
| Docker | Containerised deployment | `scripts/sep0008-server/Dockerfile` |
| Mock-mode Jest suite | Integration + unit tests via supertest | `scripts/sep0008-server/test/` |

## Open

### Contracts (Rust/Soroban)

| Issue | Description | Complexity |
|---|---|---|
| Oracle-enforced mint gate | `mint()` should refuse when `oracle.is_qualified()` is false or stale. The on-chain wiring (cross-contract call) needs a shared deployment where the oracle contract id is known to the token contract. | High |
| Multi-sig admin | Replace single admin key with a Soroban native multisig (≥ 2-of-3, ideally 3-of-5). Two-step handover is in place; the multisig sits above it. | High |
| Lazy-prune tracked addresses | Drop addresses from `TrackedAddresses` / `TrackedAllowances` once their balance is zero for an extended period and no other persistent state exists, to keep the books bounded over the contract's lifetime | Medium |

### SDK (TypeScript)

| Issue | Description | Complexity |
|---|---|---|
| Event listeners | Subscribe to MINT, BURN, TRANSFER, BLOCKLIST, PROPOSE, ACCEPT, CANCEL events | High |
| Retry logic | Handle RPC failures and `getTransaction` timeouts gracefully (current SDK bails on first error) | Medium |
| Real KYC / sanctions / travel-rule SDKs | Not applicable — those live in the SEP-0008 hook server, not the SDK | — |

### SEP-0008 Hook Server (Node.js/TypeScript)

| Issue | Description | Complexity |
|---|---|---|
| Real provider clients | HTTP clients for Jumio / Chainalysis / Notabene / Sygna behind the existing `KycProvider` / `SanctionsProvider` / `TravelRuleProvider` interfaces | High |
| Decision persistence | Persist `{tx_hash, decision, decided_at, expires_at_ledger}` in Redis or SQL so `/status/:txHash` is answerable and the compliance team can audit history | Medium |
| On-chain recording | Optionally call `compliance_hook.approve_transaction(tx_hash)` after signing for an auditable on-chain trail | Medium |
| Rate limiting | The `RATE_LIMIT_PER_MIN` env var is read but not enforced; plug in `express-rate-limit` or push to the LB | Trivial |
| Testnet integration tests | Run the Jest suite against a local or testnet Stellar node (today's suite is mock-mode only) | Medium |

### Documentation

| Issue | Description | Complexity |
|---|---|---|
| Deployment guide | Step-by-step mainnet deployment (key ceremony, oracle-onboarding, multisig wiring) | Medium |
| Audit checklist expansion | Tighten the pre-launch checklist in `SECURITY.md` with concrete tooling references (e.g., `cargo audit`, `stellar-cli` ledger dumpers) | Medium |

## Code Style

- Rust: `cargo fmt` and `cargo clippy --deny warnings`
- TypeScript: ESLint with the project config
- Commit messages: `type(scope): description` (e.g., `feat(emt_token): add transfer_from`)

## Pull Request Process

1. Fork the repository and create a branch from `main`
2. Make your changes with tests
3. Ensure `cargo test` and `npm test` pass
4. Open a PR with a clear description of what you changed and why
5. Reference the issue number in the PR description

## Security

If you discover a security vulnerability, please do **not** open a public
issue. Email the maintainers directly. See [SECURITY.md](SECURITY.md).
