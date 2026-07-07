# MiCAR-Compliant Euro Stablecoin on Stellar

> A reference implementation of a **MiCAR-compliant Euro-pegged E-Money
> Token (EMT)** on the **Stellar** network, written in **Soroban** smart
> contracts and a typed **TypeScript SDK**.

[![CI](https://img.shields.io/badge/CI-configured-blue) — see [.github/workflows/ci.yml](.github/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue)](LICENSE)
[![Soroban SDK](https://img.shields.io/badge/soroban--sdk-21.0.0-purple)](contracts/Cargo.toml)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-08b5e5)](https://stellar.org/soroban)

---

## Why this project exists

MiCAR (Regulation EU 2023/1114) entered full application on
**30 December 2024**, the world's most comprehensive crypto-asset
regulation. The Euro stablecoin market has grown rapidly since then,
driven by a small but growing cohort of MiCAR-compliant issuers.

Stellar is uniquely positioned for regulated stablecoins:

- **Native asset controls** — freeze, clawback, authorization
- **SEP-0008 Regulated Assets** — a battle-tested compliance-hook pattern
- **Fast finality** — ~5 s ledger close
- **Low cost** — a fraction of a cent per transaction
- **Live institutional deployments** — EURCV by SG-Forge is on Stellar

This repo gives any EU-authorised EMI or credit institution an open
starting point to issue a compliant Euro stablecoin on Stellar.

---

## Table of contents

1. [Architecture](#architecture)
2. [Repository layout](#repository-layout)
3. [Quick start](#quick-start)
4. [MiCAR compliance matrix](#micar-compliance-matrix)
5. [Project status](#project-status)
6. [SEP-0008 compliance](#sep-0008-compliance)
7. [Documentation](#documentation)
8. [Security](#security)
9. [Contributing](#contributing)
10. [Reference implementations](#reference-implementations)
11. [License](#license)

---

## Architecture

```text
┌─────────────────────────────────────── Off-chain ──────────────────────────────────────┐
│  KYC/AML provider  →  SEP-0008 hook server  (KYC · sanctions · limits · travel rule) │
│  Reserve custodian →  Oracle attestors    (push attestations periodically)            │
└──────────────────────────┬──────────────────────────────────────────────────────────────┘
                           │ approve tx / submit attestation
                           ▼
┌─────────────────────────────────────── Soroban ───────────────────────────────────────┐
│ emt_token            →  mint · burn · transfer · approve · transfer_from               │
│                        pause · blocklist · clawback · reserve hash                    │
│ compliance_hook      →  approve / reject / revoke tx-hashes (with TTL)                │
│ oracle_interface     →  quorum + staleness + collateral ratio                          │
└──────────────────────────┬──────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    TypeScript SDK  (@eur-emt/sdk)
```

Read [`docs/architecture.md`](docs/architecture.md) for the full design.

---

## Repository layout

```
contracts/                Soroban smart contracts (Rust)
├── emt_token/              Core EMT token (mint/burn/transfer/allowances,
|                           velocity, aggregate cap, admin handover,
|                           extend_storage_ttl)
├── compliance_hook/        SEP-0008 approval ledger with TTL
└── oracle_interface/       Reserve attestation oracle with quorum & freshness

sdk/                      TypeScript SDK (@eur-emt/sdk)
├── src/
│   ├── EmtClient.ts        Read & write methods, error wrapping
│   └── index.ts            Public barrel
├── __tests__/              Jest unit tests with mocked Soroban RPC
└── README.md               SDK reference

scripts/                  Deployment & automation
├── deploy.sh                Build wasm + deploy + write .deployment.json
├── initialize.sh            Read .deployment.json + assign roles
├── rotate-admin.sh          One-shot two-step admin handover
├── verify.sh                Local CI mirror (fmt + clippy + test + sdk test)
└── sep0008-server/          Off-chain SEP-0008 hook server (Express + TS)
    ├── src/                 Express app, providers, signer, XDR decoder
    ├── test/                Jest suite (mock-mode integration + unit)
    └── Dockerfile           Containerised deployment

docs/                     Design & compliance documentation
├── architecture.md          System design
├── micar-compliance.md      MiCAR obligations mapping
├── admin-handover.md        Two-step admin rotation runbook
└── sep0008-hook.md          Off-chain hook server spec

.github/workflows/        CI (fmt + clippy + test + sdk build + docs sanity)
SECURITY.md               Vulnerability disclosure policy & pre-launch checklist
.env.example              Environment variable template
lefthook.yml              Local pre-commit / pre-push gate (mirrors CI)
```

---

## Quick start

### Prerequisites

- Rust (stable) **+** the `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli)
- Node.js 20+ (for the SDK and scripts)

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked stellar-cli --features opt
```

### Build & test the contracts

```bash
cd contracts
cargo build --release --target wasm32-unknown-unknown
cargo test                     # unit tests
cargo clippy --all-targets -- -D warnings
```

### Build the SDK

```bash
cd sdk
npm install
npm run build
```

### Deploy to testnet

```bash
cp .env.example .env
# … fill in funded secret & address values, then:
set -a && source .env && set +a

./scripts/deploy.sh     # writes contract IDs to .deployment.json
./scripts/initialize.sh # reads .deployment.json + assigns roles
```

A mainnet deployment is refused unless `I_UNDERSTAND_MAINNET=1` is set.

---

## MiCAR compliance matrix

| Article | Requirement | Implementation |
|---|---|---|
| Art. 48 | Redemption at par | `emt_token::burn` + off-chain fiat release |
| Art. 45 | Reserve segregation & attestation | `oracle_interface` (push oracle) + `EMT.reserve_attestation` |
| Art. 23 | AML/CFT controls | `blocklist` + SEP-0008 hook + reserve oracle |
| Art. 22 | Travel rule (> €1,000) | Hook server (off-chain) — _see `sep0008-hook.md`_ |
| Art. 46 | Transaction limits | Per-address 24h velocity limit (two-bucket sliding window) + global default |
| Art. 46 | Aggregate mint cap | `emt_token::set_aggregate_mint_cap` (admin) enforces a hard ceiling on `total_supply` in `mint()`. `0` means unlimited; `unset_aggregate_mint_cap` removes the cap. Refuses to set a cap below the current supply. |
| Art. 23 / 48 | 5-year record retention | `emt_token::extend_storage_ttl` (admin cron / governance) batch-extends every Balance / Allowance / Blocklisted / VelocityLimit / VelocityState entry plus the tracking books to the host ceiling. Per-write TTL bumps on every state mutation; periodic batch refresh is the contract-internal complement. |
| Art. 35 | Issuer authorisation | _Legal obligation — enforced outside the smart contracts_ |

Read [`docs/micar-compliance.md`](docs/micar-compliance.md) for the full mapping.

---

## Project status

| Component | Mint / Burn | Pause | Blocklist | Allowances | Reserve attest. | Admin handover |
|---|---|---|---|---|---|---|
| `emt_token` | ✅ | ✅ | ✅ | ✅ (`approve` / `transfer_from`) | ✅ | ✅ two-step (propose + accept) + cancel |
| `compliance_hook` | ✅ approve/reject | ✅ revoke | ✅ expiry TTL | — | — | — |
| `oracle_interface` | ✅ push attestations | ✅ quorum | ✅ staleness | ✅ collateral ratio | — | — |

Things explicitly **not** done yet (see [`CONTRIBUTING.md`](CONTRIBUTING.md)):

- Lazy-prune `TrackedAddresses` / `TrackedAllowances` (drop addresses with zero balance and no other state to keep the books bounded as the contract's lifetime grows)
- Fuzz / property-based tests
- Real KYC / sanctions / travel-rule provider clients in the SEP-0008 hook server (the skeleton ships mock providers; the integration interfaces are in place)

---

## SEP-0008 compliance

For Stellar this is partially on-chain (the `compliance_hook` contract
records approvals with a TTL) and partially off-chain (the hook server
that screens KYC, sanctions, transaction limits, and travel-rule data
before co-signing the user's transaction).

See [`docs/sep0008-hook.md`](docs/sep0008-hook.md) for the off-chain
server specification and the proposed OpenAPI surface.

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — overall system design
- [`docs/micar-compliance.md`](docs/micar-compliance.md) — per-article
  obligation mapping
- [`docs/sep0008-hook.md`](docs/sep0008-hook.md) — off-chain hook server
- [`docs/admin-handover.md`](docs/admin-handover.md) — two-step admin rotation runbook
- [`sdk/README.md`](sdk/README.md) — SDK reference
- [`SECURITY.md`](SECURITY.md) — disclosure policy
- [`.env.example`](.env.example) — environment template

---

## Security

If you find a security issue, **do not open a public issue**. Email the
maintainers directly per [`SECURITY.md`](SECURITY.md).

Before deploying to mainnet with real funds, follow the **Pre-Launch
Checklist** in `SECURITY.md`. Independent security audits and a bug
bounty are required by the time real funds are involved.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Issues span three areas
(contracts, SDK, hook server) and every complexity level, from trivial
docs fixes to full reserve-oracle quorum logic.

---

## Reference implementations

Patterns adapted from:

- **[circlefin/stablecoin-evm](https://github.com/circlefin/stablecoin-evm)**
  (Apache-2.0) — Circle's USDC architecture on EVM. Inspiration for the
  role model, blocklist, and pause.
- **[membranefi/euroe-stablecoin](https://github.com/membranefi/euroe-stablecoin)**
  — Membrane Finance's MiCAR-compliant EUROe on Ethereum. Same
  regulatory regime, different chain — useful sanity check.
- **[stellar/soroban-examples](https://github.com/stellar/soroban-examples)**
  — official Soroban patterns (auth helpers, storage, events).

---

## License

Apache-2.0. See [`LICENSE`](LICENSE).
