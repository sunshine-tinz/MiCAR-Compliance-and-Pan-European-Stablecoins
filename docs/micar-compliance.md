# MiCAR Compliance Guide

## What is MiCAR?

The Markets in Crypto-Assets Regulation (MiCAR / MiCA) is EU law that entered
full application on **30 December 2024**. It creates a unified regulatory
framework for crypto-assets across all 27 EU member states.

For stablecoins, MiCAR defines two categories:

| Type | Definition | Example |
|---|---|---|
| **EMT** (E-Money Token) | Pegged to a single fiat currency | EUREMT (this project) |
| **ART** (Asset-Referenced Token) | Pegged to a basket of assets | — |

This project implements an **EMT** pegged to the Euro.

## Key Obligations and How This Project Addresses Them

### Art. 48 — Right of Redemption at Par

> Token holders must be able to redeem their tokens at par value at any time.

**Implementation:**
- `burn()` in `emt_token` is the on-chain leg of redemption
- Off-chain: the issuer must release fiat within the statutory period
- **Open:** a `request_redemption` event that triggers the off-chain flow is not yet emitted by the contract (the off-chain redemption queue exists as a separate workflow)

### Art. 45 — Reserve Asset Requirements

> Reserve assets must equal outstanding token supply and be segregated from
> the issuer's own assets.

**Implementation:**
- `oracle_interface` contract stores reserve attestations on-chain with quorum + staleness checks (`set_quorum`, `set_max_attestation_age`, `is_qualified`)
- `set_reserve_attestation()` in `emt_token` anchors the attestation document hash
- `submit_attestation` is attestor-gated and refuses under-collateralised reports (`reserve_balance must cover token_supply`)
- `emt_token::mint()` gates every issuance on `oracle_interface.is_qualified()`: if the oracle contract address is unset, `mint()` panics ("oracle contract not configured"); if `is_qualified()` returns false (quorum unmet or attestation stale), `mint()` panics ("oracle is not qualified"). Admin wires the oracle post-deploy via `set_oracle_contract(address)`; rotation is supported by calling the setter again

### Art. 23 — AML/CFT Controls

> Issuers must implement AML/CFT procedures equivalent to those for e-money.

**Implementation:**
- `blocklist` / `unblocklist` in `emt_token` for sanctions enforcement (TTL-backed to the host ceiling so a blocklist cannot silently expire — MiCAR Art. 23 compliance fault)
- `compliance_hook` contract records SEP-0008 approvals with an `APPROVAL_TTL_LEDGERS` ledger window
- Off-chain: the SEP-0008 hook server (`scripts/sep0008-server/`) screens every transaction against KYC, sanctions, velocity limits, and travel-rule data
- **Open:** Real KYC / sanctions / travel-rule provider clients are stubbed behind the `KycProvider` / `SanctionsProvider` / `TravelRuleProvider` interfaces; the in-process mocks are wired by default (`MOCK_MODE=1`). A production deployment plugs HTTP clients into those interfaces

### Art. 23 / Art. 48 — 5-Year Record Retention

> EMI issuers must retain records for at least 5 years after the relationship ends.

**Implementation:**
- `emt_token::extend_storage_ttl` is an admin entry that batch-extends every Balance / Allowance / Blocklisted / VelocityLimit / VelocityState entry, plus the `TrackedAddresses` / `TrackedAllowances` index books, to the Soroban host ceiling
- Per-write TTL bumps run on every state-mutating call (host ceiling ≈ 1 year per entry; the admin cron closes the remaining 4 years)
- The contract-internal tracking books ensure the address space is enumerable (Soroban persistent storage does not support key iteration natively)

### Art. 46 — Transaction Limits

> The ECB may impose limits on EMT transactions to protect monetary policy.

**Implementation:**
- Per-address 24h outgoing-volume cap: two-bucket sliding window in `emt_token` (`set_global_velocity_limit`, `set_velocity_limit`, `clear_velocity_limit`, `get_velocity_limit`, `get_outflow_today`). Charged against the `from` address on both `transfer` and `transfer_from`
- Aggregate supply cap: `emt_token::set_aggregate_mint_cap` enforces a hard ceiling on `total_supply`; `unset_aggregate_mint_cap` removes it; both refuse to set a cap below the existing supply (would silently brick future mints)
- The off-chain SEP-0008 hook server also projects a transfer against the on-chain cap (`EmtTokenLimitsProvider`, MiCAR Art. 22 compliance fault off → no signature)

### Art. 22 — Travel Rule (FATF)

> For transfers above €1,000, originator and beneficiary information must
> accompany the transaction.

**Implementation:**
- The SEP-0008 hook server (`scripts/sep0008-server/`) collects originator + beneficiary fields and validates them against the threshold inside `TravelRuleProvider.missingData`
- `TxApproveRequest` carries `originator` / `beneficiary` per the spec
- **Open:** Real provider integration (Notabene, Sygna, etc.) is stubbed behind the `TravelRuleProvider` interface, same pattern as KYC / sanctions

### Art. 35 — Authorisation

> EMT issuers must be an EU-authorised credit institution or e-money institution.

**Note:** This is a legal requirement, not a technical one. The smart contracts
enforce the technical controls; the issuer must hold the appropriate licence.
As of March 2026, 19 EMT issuers are authorised across the EU.

## Compliance Architecture Diagram

```
User Wallet
    │
    │ 1. Build transaction
    ▼
SEP-0008 Hook Server (off-chain)
    │
    ├── 2a. Check KYC status (KYC provider API)
    ├── 2b. Screen against sanctions list
    ├── 2c. Check transaction limits
    ├── 2d. Collect travel rule data (if > €1,000)
    │
    ├── REJECT → return error to wallet
    │
    └── APPROVE → co-sign transaction
                │
                │ 3. Submit signed transaction
                ▼
         Stellar Network
                │
                ▼
         emt_token contract
                │
                ├── Check not paused
                ├── Check not blocklisted
                └── Execute transfer
```

## Regulatory References

- [MiCAR full text (EUR-Lex)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1114)
- [EBA Guidelines on EMTs](https://www.eba.europa.eu/regulation-and-policy/crypto-assets)
- [ESMA MiCAR Q&A](https://www.esma.europa.eu/press-news/esma-news/esma-publishes-qa-micar)
- [SEP-0008 Regulated Assets](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md)

## Disclaimer

This project provides a technical reference implementation. It does not
constitute legal advice. Issuers must obtain appropriate legal counsel and
regulatory authorisation before issuing EMTs under MiCAR.
