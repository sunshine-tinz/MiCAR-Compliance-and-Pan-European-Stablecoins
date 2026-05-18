# MiCAR-Compliant Euro Stablecoin on Stellar

A reference implementation of a **MiCAR-compliant Euro-pegged E-Money Token
(EMT)** on the [Stellar](https://stellar.org) network using
[Soroban](https://stellar.org/soroban) smart contracts.

## Why This Exists

MiCAR (Markets in Crypto-Assets Regulation) entered full application on
30 December 2024, creating the world's most comprehensive stablecoin regulatory
framework. The Euro stablecoin market has doubled since early 2025, reaching
~$909M, driven entirely by MiCAR-compliant issuers.

Stellar is uniquely positioned for regulated stablecoins:
- Built-in asset controls (freeze, clawback, authorization)
- SEP-0008 standard for regulated asset compliance hooks
- Fast finality (<6 seconds), low cost ($0.0007/tx)
- Existing institutional deployments (EURCV by SG-Forge is live on Stellar)

This project provides the open-source infrastructure layer that any
EU-authorised EMI or credit institution can build on to issue a compliant
Euro stablecoin on Stellar.

## Architecture

```
emt_token (Soroban)          compliance_hook (Soroban)
  ├── mint / burn              ├── approve_transaction
  ├── transfer                 └── reject_transaction
  ├── blocklist / clawback
  └── pause                  oracle_interface (Soroban)
                               ├── submit_attestation
SEP-0008 Hook Server           └── latest_attestation
  ├── KYC screening
  ├── Sanctions check        TypeScript SDK
  └── Travel rule              └── EmtClient
```

See [docs/architecture.md](docs/architecture.md) for the full design.

## MiCAR Compliance

| Article | Requirement | Implementation |
|---|---|---|
| Art. 48 | Redemption at par | `burn()` + off-chain fiat release |
| Art. 45 | Reserve segregation | `oracle_interface` attestations |
| Art. 23 | AML/CFT controls | Blocklist + SEP-0008 hook |
| Art. 46 | Transaction limits | TODO: velocity limits |
| Art. 22 | Travel rule | TODO: hook server |

See [docs/micar-compliance.md](docs/micar-compliance.md) for the full mapping.

## Quick Start

### Prerequisites

- Rust + `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli)
- Node.js 20+

```bash
# Install Rust wasm target
rustup target add wasm32-unknown-unknown

# Build contracts
cd contracts && cargo build --release --target wasm32-unknown-unknown

# Run tests
cargo test

# Install SDK
cd ../sdk && npm install
```

### Deploy to Testnet

```bash
export ADMIN_SECRET=S...
export MINTER_ADDRESS=G...
export PAUSER_ADDRESS=G...
export BLOCKLISTER_ADDRESS=G...

./scripts/deploy.sh
./scripts/initialize.sh
```

## Contributing

This project is designed for open contribution. There are well-defined issues
across contracts, SDK, and the SEP-0008 hook server at every complexity level.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list of open issues and
how to get started.

## Reference Implementations

This project adapts patterns from:

- **[circlefin/stablecoin-evm](https://github.com/circlefin/stablecoin-evm)**
  (Apache-2.0) — Circle's USDC architecture on EVM
- **[membranefi/euroe-stablecoin](https://github.com/membranefi/euroe-stablecoin)**
  — Membrane Finance's MiCAR-compliant EUROe on Ethereum

## License

Apache-2.0
