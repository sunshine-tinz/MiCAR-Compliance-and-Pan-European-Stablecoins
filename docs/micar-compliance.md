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
- TODO: implement a `request_redemption` event that triggers the off-chain flow

### Art. 45 — Reserve Asset Requirements

> Reserve assets must equal outstanding token supply and be segregated from
> the issuer's own assets.

**Implementation:**
- `oracle_interface` contract stores reserve attestations on-chain
- `set_reserve_attestation()` in `emt_token` anchors the attestation document hash
- TODO: enforce that `mint()` can only proceed if reserve ≥ supply + mint_amount

### Art. 23 — AML/CFT Controls

> Issuers must implement AML/CFT procedures equivalent to those for e-money.

**Implementation:**
- `blocklist` / `unblocklist` in `emt_token` for sanctions enforcement
- `compliance_hook` contract records SEP-0008 approvals
- Off-chain: SEP-0008 hook server screens every transaction against KYC/AML
- TODO: integrate a sanctions screening API (e.g., Chainalysis, Elliptic)

### Art. 46 — Transaction Limits

> The ECB may impose limits on EMT transactions to protect monetary policy.

**Implementation:**
- TODO: per-address daily transfer limits in `emt_token`
- TODO: aggregate supply cap enforced in `mint()`

### Art. 22 — Travel Rule (FATF)

> For transfers above €1,000, originator and beneficiary information must
> accompany the transaction.

**Implementation:**
- TODO: SEP-0008 hook server collects and forwards travel rule data
- TODO: integrate with a travel rule solution (e.g., Notabene, Sygna)

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
