/**
 * SEP-0008 Hook Server entry point.
 *
 * Wires together:
 *   - config (env vars, validated at startup)
 *   - compliance providers (HTTP-based real ones when MOCK_MODE=0,
 *     in-process mocks otherwise)
 *   - Stellar signer
 *   - Express app with health, ready, status, and tx-approve endpoints
 *   - API-key auth middleware for /tx-approve
 *
 * See docs/sep0008-hook.md for the full spec.
 */

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { loadConfig, type Config } from "./config";
import {
  HttpKycProvider,
  MockKycProvider,
  type KycProvider,
} from "./compliance/kyc";
import {
  HttpSanctionsProvider,
  MockSanctionsProvider,
  type SanctionsProvider,
} from "./compliance/sanctions";
import {
  EmtTokenLimitsProvider,
  MockLimitsProvider,
  type LimitsProvider,
} from "./compliance/limits";
import { MockTravelRuleProvider, type TravelRuleProvider } from "./compliance/travelRule";
import { StellarSigner } from "./stellar/signer";
import { makeTxApproveHandler } from "./handlers/txApprove";

const config = loadConfig();

// ── Provider wiring ────────────────────────────────────────────────────────────
//
// Each provider follows a fail-loud two-state pattern:
//
//  1. `MOCK_MODE=1`         → use the in-process Mock* (default).
//  2. `MOCK_MODE=0` + URL   → use the real HTTP provider (production).
//
// `MOCK_MODE=0` with a missing provider URL throws at startup. A
// silent fallback to MockKycProvider in production would let a
// misconfigured deploy route every wallet through the in-process
// "anything not GVERIFIED* is pending" branch — operators would
// notice nothing until a real customer hit the KYC queue. Failing
// at process startup keeps the failure mode loudly visible.

if (!config.mockMode && !config.providers.kyc) {
  throw new Error(
    "[startup] MOCK_MODE=0 but KYC_PROVIDER_URL is unset — refusing " +
      "to start. Set MOCK_MODE=1 for offline dev, or wire " +
      "KYC_PROVIDER_URL + KYC_PROVIDER_API_KEY for production."
  );
}
if (!config.mockMode && !config.providers.sanctions) {
  throw new Error(
    "[startup] MOCK_MODE=0 but SANCTIONS_PROVIDER_URL is unset — " +
      "refusing to start. Set MOCK_MODE=1 for offline dev, or wire " +
      "SANCTIONS_PROVIDER_URL + SANCTIONS_PROVIDER_API_KEY for production."
  );
}

const kyc: KycProvider = config.mockMode
  ? new MockKycProvider()
  : new HttpKycProvider({
      url: config.providers.kyc!.url,
      apiKey: config.providers.kyc!.apiKey,
    });

const sanctions: SanctionsProvider = config.mockMode
  ? new MockSanctionsProvider()
  : new HttpSanctionsProvider({
      url: config.providers.sanctions!.url,
      apiKey: config.providers.sanctions!.apiKey,
    });

// LimitsProvider: mock (default, dev/test) or real (production).
// The real provider reads `emt_token.get_velocity_limit(addr)` and
// `emt_token.get_outflow_today(addr)` via Soroban RPC. See
// docs/sep0008-hook.md §6.
const limits: LimitsProvider = config.mockMode
  ? new MockLimitsProvider()
  : new EmtTokenLimitsProvider({
      rpcUrl: config.stellar.rpcUrl,
      contractId: config.contracts.emtTokenId,
      networkPassphrase: config.stellar.networkPassphrase,
    });
const travelRule: TravelRuleProvider = new MockTravelRuleProvider();
const signer = new StellarSigner(config.stellar.hookServerKeypair);

const app = express();
app.use(express.json({ limit: "256kb" }));

// Simple per-process request log.
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (config.logLevel === "debug") {
    // eslint-disable-next-line no-console
    console.debug(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// API-key auth for /tx-approve. Wallets present
// `Authorization: Bearer <API_KEY>`. /health, /ready, and /status are
// unauthenticated (front them with a network policy in production).
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m || m[1] !== config.apiKey) {
    res.status(401).json({ error: "missing or invalid API key" });
    return;
  }
  next();
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.get("/ready", (_req: Request, res: Response) => {
  // The skeleton is always "ready" — a real impl would check
  // provider connectivity here. With the HTTP providers wired, this
  // could PING each configured vendor on demand; kept as a TODO
  // because vendor-specific ping endpoints aren't predictable.
  //
  // If we reach this handler, startup passed the fail-loud checks
  // above, so every provider is either wired (MOCK_MODE=0) or in
  // process (MOCK_MODE=1). There's no third state to surface.
  res.status(200).json({
    status: "ready",
    providers: {
      kyc: "ok",
      sanctions: "ok",
      limits: "ok",
      travel_rule: "ok",
      onchain_rpc: "ok",
    },
  });
});

app.get("/status/:txHash", (_req: Request, res: Response) => {
  // The skeleton doesn't persist decisions; a real impl would look
  // them up from a small KV (e.g. Redis) keyed by tx hash.
  res.status(404).json({ error: "no decision recorded for this tx hash" });
});

app.post(
  "/tx-approve",
  requireApiKey,
  makeTxApproveHandler({
    kyc,
    sanctions,
    limits,
    travelRule,
    signer,
    networkPassphrase: config.stellar.networkPassphrase,
    approvalTtlLedgers: 17_280,
  })
);

// eslint-disable-next-line no-console
app.listen(config.port, () => {
  console.log(
    `SEP-0008 hook server listening on :${config.port} ` +
      `(network=${config.stellar.network}, mock_mode=${config.mockMode})`
  );
});
