# Architecture

## Overview

This project implements a MiCAR-compliant Euro-pegged E-Money Token (EMT) on
the Stellar network using Soroban smart contracts.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Off-Chain Layer                          │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  KYC/AML     │   │  SEP-0008    │   │  Reserve Custodian │  │
│  │  Provider    │──▶│  Hook Server │   │  (EU bank / T-bill)│  │
│  └──────────────┘   └──────┬───────┘   └────────┬───────────┘  │
│                            │                    │               │
└────────────────────────────┼────────────────────┼───────────────┘
                             │ approve_tx          │ submit_attestation
                             ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Soroban Contracts                         │
│                                                                 │
│  ┌─────────────────┐   ┌──────────────────┐   ┌─────────────┐  │
│  │   emt_token     │◀──│ compliance_hook  │   │  oracle_    │  │
│  │                 │   │                  │   │  interface  │  │
│  │  - mint/burn    │   │  - approve_tx    │   │             │  │
│  │  - transfer     │   │  - reject_tx     │   │  - attest   │  │
│  │  - blocklist    │   │  - is_approved   │   │  - latest   │  │
│  │  - pause        │   └──────────────────┘   └─────────────┘  │
│  │  - clawback     │                                            │
│  │  - reserve_hash │                                            │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TypeScript SDK                              │
│                                                                 │
│   EmtClient — typed wrapper for all contract interactions       │
└─────────────────────────────────────────────────────────────────┘
```

## Contracts

### `emt_token`

The core EMT contract. Implements the token lifecycle:

| Function | Role Required | Description |
|---|---|---|
| `initialize` | — | One-time setup, sets all roles |
| `mint` | minter | Create tokens after fiat receipt |
| `burn` | minter | Destroy tokens on redemption |
| `transfer` | sender (self) | Move tokens between addresses |
| `clawback` | admin | Reclaim tokens (sanctions/court order) |
| `pause` / `unpause` | pauser | Emergency circuit-breaker |
| `blocklist` / `unblocklist` | blocklister | AML/sanctions enforcement |
| `set_reserve_attestation` | admin | Anchor off-chain reserve proof |

### `compliance_hook`

On-chain record of SEP-0008 compliance approvals. The off-chain hook server
calls `approve_transaction` or `reject_transaction` before a transfer is
submitted to the network.

### `oracle_interface`

Stores reserve attestation data pushed by authorised attestors (auditors,
custodians). The `emt_token` contract reads from this before large mints.

## Role Model

```
admin
 ├── can update all other roles
 ├── can clawback tokens
 └── can set reserve attestation hash

minter
 ├── can mint tokens (after fiat receipt)
 └── can burn tokens (on redemption request)

pauser
 └── can pause/unpause all transfers

blocklister
 ├── can block addresses (AML/sanctions)
 └── can unblock addresses
```

## Stellar-Specific Design Decisions

**Why Soroban instead of Stellar Classic assets?**

Stellar Classic assets have built-in `AUTH_REQUIRED`, `AUTH_REVOCABLE`, and
`AUTH_CLAWBACK_ENABLED` flags that map directly to MiCAR requirements. However,
Soroban contracts give us:
- Programmable compliance logic (velocity limits, per-address caps)
- Composability with DeFi protocols on Soroban
- Richer event emission for compliance audit trails
- Upgradeable logic without asset migration

The recommended production architecture uses **both**: a Stellar Classic asset
for the actual token (leveraging native DEX and wallet support) with a Soroban
contract as the compliance controller that must co-sign all operations.

**SEP-0008 Regulated Assets**

SEP-0008 defines a standard for regulated assets on Stellar. The compliance
hook server intercepts transactions before submission, checks KYC/AML status,
and either approves (co-signs) or rejects them. This is the primary mechanism
for MiCAR Art. 23 (AML/CFT) compliance.

See [SEP-0008 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md).

## Reference Implementations

This project draws from:

- **[circlefin/stablecoin-evm](https://github.com/circlefin/stablecoin-evm)**
  (Apache-2.0) — Circle's USDC on EVM. Most mature stablecoin contract
  architecture. We adapted the role model, blocklist, and pause mechanism.

- **[membranefi/euroe-stablecoin](https://github.com/membranefi/euroe-stablecoin)**
  — Membrane Finance's EUROe, a MiCAR-compliant Euro stablecoin on Ethereum.
  Directly relevant: same regulatory requirements, Hardhat/Solidity stack.

- **[stellar/soroban-examples](https://github.com/stellar/soroban-examples)**
  — Official Soroban contract examples for Stellar-specific patterns.

## What's Missing (Contribution Opportunities)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full list of open issues.
High-impact areas:

1. **Oracle-enforced mint gate** — `mint()` should refuse when
   `oracle.is_qualified()` is false or stale. The interfaces are in
   place; the cross-contract call needs a single Soroban deployment
   that exposes the oracle's contract id to the token contract.
2. **Multi-sig admin** — Replace the single admin key with a Soroban
   native multisig (≥ 2-of-3, ideally 3-of-5) for institutional-grade
   key management. Two-step handover (`propose_admin` / `accept_admin`)
   is in place; the multisig sits above it.
3. **Lazy-prune tracked addresses** — Drop addresses from
   `TrackedAddresses` / `TrackedAllowances` once their balance has been
   zero for an extended period and they have no other persistent
   state, to keep the books bounded as the contract's lifetime grows.
4. **Real KYC / sanctions / travel-rule provider clients** — the
   interfaces ship in `scripts/sep0008-server/src/compliance/`; HTTP
   clients (Jumio / Chainalysis / Notabene) are the next step.
5. **Property-based / fuzz tests** — for mint/burn/transfer arithmetic,
   overflow edges, and the velocity sliding-window transitions.
