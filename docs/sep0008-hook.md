# SEP-0008 Compliance Hook Server

## Overview

SEP-0008 (Regulated Assets) defines a protocol for Stellar assets that require
issuer approval before transfers can be executed. This document describes the
off-chain hook server that must be built to complete the compliance flow.

## How It Works

```
1. Wallet builds a Stellar transaction (transfer, etc.)
2. Wallet POSTs the transaction XDR to the hook server
3. Hook server:
   a. Decodes the transaction
   b. Identifies sender and receiver
   c. Checks KYC status of both parties
   d. Screens against sanctions lists
   e. Checks transaction amount against limits
   f. Collects travel rule data if amount > €1,000
4a. If approved: server signs the transaction and returns it
4b. If rejected: server returns an error with reason code
5. Wallet submits the signed transaction to Stellar
```

## API Specification (to be implemented)

### `POST /tx-approve`

Request body:
```json
{
  "tx": "<base64-encoded transaction XDR>"
}
```

Success response (HTTP 200):
```json
{
  "status": "success",
  "tx": "<base64-encoded signed transaction XDR>"
}
```

Rejection response (HTTP 400):
```json
{
  "status": "rejected",
  "error": "Sender is on sanctions list"
}
```

Pending response (HTTP 200, requires additional info):
```json
{
  "status": "pending",
  "error": "KYC verification required",
  "action_required": "https://kyc.example.com/verify?ref=abc123"
}
```

## Implementation Guide

The hook server should be a Node.js/TypeScript (or Python) HTTP server.

### Key Dependencies
- `@stellar/stellar-sdk` — decode and sign transactions
- A KYC provider SDK (e.g., Jumio, Onfido, Sumsub)
- A sanctions screening API (e.g., Chainalysis, Elliptic, ComplyAdvantage)
- A travel rule solution (e.g., Notabene, Sygna Bridge)

### Skeleton Structure

```
scripts/sep0008-server/
├── src/
│   ├── index.ts          # Express server entry point
│   ├── handlers/
│   │   └── txApprove.ts  # POST /tx-approve handler
│   ├── compliance/
│   │   ├── kyc.ts        # KYC status checks
│   │   ├── sanctions.ts  # Sanctions screening
│   │   ├── limits.ts     # Transaction limit enforcement
│   │   └── travelRule.ts # Travel rule data collection
│   └── stellar/
│       └── signer.ts     # Transaction signing with hook server key
├── package.json
└── README.md
```

## TODO for Contributors

- [ ] Implement the Express server skeleton (`src/index.ts`)
- [ ] Implement `POST /tx-approve` handler
- [ ] Add KYC check stub with interface for plugging in a real provider
- [ ] Add sanctions screening stub
- [ ] Add transaction limit check (read limits from `emt_token` contract)
- [ ] Add travel rule data collection for transactions > €1,000
- [ ] Write integration tests with a local Stellar testnet
- [ ] Add Docker configuration for easy deployment
- [ ] Document the environment variables required

## Reference

- [SEP-0008 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md)
- [Stellar Regulated Assets Guide](https://developers.stellar.org/docs/tokens/control-asset-access)
