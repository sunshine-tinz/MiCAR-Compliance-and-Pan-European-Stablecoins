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
└── src/
    └── EmtClient.ts    # TypeScript SDK client

scripts/
├── deploy.sh           # Deploy contracts to testnet
├── initialize.sh       # Initialize contract roles
└── sep0008-server/     # Off-chain compliance hook server (TODO)

docs/
├── architecture.md     # System design
├── micar-compliance.md # MiCAR obligations mapping
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
impact. Each maps to a GitHub issue.

### Contracts (Rust/Soroban)

| Issue | Description | Complexity |
|---|---|---|
| `transfer_from` | Delegated transfers with allowances | Medium |
| `approve` | ERC-20-style allowance mechanism | Medium |
| Transfer velocity limits | Per-address daily/weekly caps (MiCAR Art. 46) ✅ shipped | High |
| Two-step admin transfer | Propose + accept pattern for admin role handover ✅ shipped | Medium |
| Extend-storage TTL entry point | `extend_storage_ttl` admin entry to batch-refresh persistent entry TTLs to the host ceiling for MiCAR Art. 23 / 48 5-year retention ✅ shipped | High |
| Lazy-prune tracking books | Drop addresses from `TrackedAddresses` / `TrackedAllowances` once their balance has been zero for an extended period and they have no other persistent state, to keep the books bounded over the contract's lifetime | Medium |
| Mint supply cap | Aggregate supply limit enforced in `mint()` | Trivial |
| Oracle integration | `mint()` checks oracle before proceeding | High |
| Clawback policy | Define whether clawback burns or credits admin | Trivial |
| Attestation expiry | Reject stale attestations in oracle_interface | Medium |
| Oracle quorum | Require M-of-N attestors to agree | High |
| Fuzz tests | Property-based tests for mint/burn/transfer | High |

### SDK (TypeScript)

| Issue | Description | Complexity |
|---|---|---|
| `transfer()` method | With SEP-0008 hook pre-flight | Medium |
| `mint()` method | Admin/minter operation | Medium |
| `burn()` method | Redemption operation | Medium |
| `pause()` / `unpause()` | Admin operations | Trivial |
| `blocklist()` / `unblocklist()` | Compliance operations | Trivial |
| Event listeners | Subscribe to MINT, BURN, TRANSFER events | High |
| Retry logic | Handle RPC failures gracefully | Medium |
| SDK tests | Unit tests with mock Soroban RPC | High |

### SEP-0008 Hook Server (Node.js/TypeScript)

| Issue | Description | Complexity |
|---|---|---|
| Server skeleton | Express server with `POST /tx-approve` | Medium |
| KYC check stub | Interface for plugging in a KYC provider | Medium |
| Sanctions screening | Stub + interface for sanctions API | Medium |
| Transaction limits | Read limits from `emt_token` contract | High |
| Travel rule | Collect and forward data for > €1,000 transfers | High |
| Docker config | Containerise the hook server | Trivial |
| Integration tests | Test against local Stellar testnet | High |

### Documentation

| Issue | Description | Complexity |
|---|---|---|
| OpenAPI spec | Document the hook server API | Medium |
| Deployment guide | Step-by-step mainnet deployment | Medium |
| Audit checklist | Pre-launch security checklist | Medium |

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
