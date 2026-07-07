# SEP-0008 Hook Server

Reference skeleton for the off-chain compliance hook server described
in [`../../docs/sep0008-hook.md`](../../docs/sep0008-hook.md). Built in
TypeScript on Express, with **mock providers by default** so it boots
without external credentials.

## Quick start

```bash
cd scripts/sep0008-server
cp .env.example .env
# Edit .env: set HOOK_SERVER_SECRET_KEY, EMT_CONTRACT_ID, COMPLIANCE_HOOK_CONTRACT_ID, API_KEY
npm install
npm run dev      # ts-node, hot-reload
# or:
npm run build && npm start
```

The server listens on `:${PORT}` (default 3000). Sanity-check:

```bash
curl -s http://localhost:3000/health
# → {"status":"ok"}
curl -s http://localhost:3000/ready
# → {"status":"ready","providers":{...}}
```

## Configuration

All configuration is via environment variables — see
[`.env.example`](.env.example) and the [spec §8](../../docs/sep0008-hook.md#8-environment-variables).
The skeleton validates required vars at startup and fails fast on the
first missing one.

## Mock mode

By default `MOCK_MODE=1` and the in-process mock providers are used
(`GVERIFIED*` addresses pass KYC, `GSANCTIONED*` trigger a sanctions
hit, everything else is pending). To wire up real providers, set
`MOCK_MODE=0` and fill in the `*_PROVIDER_URL` / `*_PROVIDER_API_KEY`
vars.

## Tests

```bash
npm test
```

The Jest suite boots the Express app in-process (via `supertest`) and
exercises the happy path, the four documented rejection paths
(sanctions, KYC pending, invalid XDR, missing field), and the
MiCAR Art. 46 velocity-limit rejection path.

## Project structure

```
src/
├── index.ts                    # Express app, wiring, /health, /ready
├── config.ts                   # env-var parsing
├── types.ts                    # request/response shapes (spec §2)
├── handlers/
│   └── txApprove.ts            # POST /tx-approve (the main decision flow)
├── compliance/
│   ├── kyc.ts                  # KycProvider interface + MockKycProvider
│   ├── sanctions.ts            # SanctionsProvider + MockSanctionsProvider
│   ├── limits.ts               # LimitsProvider + MockLimitsProvider
│   └── travelRule.ts           # TravelRuleProvider + MockTravelRuleProvider
└── stellar/
    ├── signer.ts               # Wraps Keypair, signs approved transactions
    └── decoder.ts              # decodeTxXdr → DecodedTx

test/
├── txApprove.test.ts           # integration tests via supertest
└── limits.test.ts              # unit tests for MockLimitsProvider + EmtTokenLimitsProvider
```

## What's intentionally NOT in the skeleton

The skeleton is enough to run integration tests against the mock
providers. A production deployment needs:

- **Real KYC / sanctions / travel-rule provider clients.** The
  interface contracts are defined in `src/compliance/*.ts`; the HTTP
  clients are the next step.
- **On-chain velocity-limit read.** Done. `EmtTokenLimitsProvider`
  reads `emt_token.get_velocity_limit(addr)` and
  `emt_token.get_outflow_today(addr)` directly via the Soroban RPC
  client. Wired in automatically when `MOCK_MODE=0`.
- **Decision persistence.** The `/status/:txHash` endpoint currently
  404s. A real impl persists `{tx_hash, decision, decided_at,
  expires_at_ledger}` in Redis or a small SQL table so the compliance
  team can audit past decisions.
- **Optional on-chain recording.** The skeleton doesn't call
  `compliance_hook.approve_transaction(tx_hash)` after signing.
  Wiring this in is a one-liner once the SDK is integrated; see the
  spec §7 for the policy trade-offs.
- **Rate limiting.** The `RATE_LIMIT_PER_MIN` env var is read but
  not enforced. Plug in `express-rate-limit` or your LB's rate
  limiter.

See [`../../docs/sep0008-hook.md`](../../docs/sep0008-hook.md) for the
full spec.
