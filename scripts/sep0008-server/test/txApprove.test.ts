/**
 * Integration test for POST /tx-approve.
 *
 * Boots the Express app in-process (no `listen()` call here — we
 * hand the app to supertest instead) and exercises the happy path,
 * the documented rejection paths, and the MiCAR Art. 46
 * velocity-limit rejection path.
 *
 * All transaction sources are `Keypair.random().publicKey()` so the
 * `Account` constructor accepts the address without choking on
 * invalid base32. Tests that need a specific compliance verdict
 * (verified, sanctions hit, pending KYC, limits throw) inject
 * per-provider overrides via the second `buildApp` argument.
 */

import express from "express";
import request from "supertest";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Account,
  Asset,
  Operation,
} from "@stellar/stellar-sdk";
import { makeTxApproveHandler } from "../src/handlers/txApprove";
import { MockKycProvider } from "../src/compliance/kyc";
import { MockSanctionsProvider } from "../src/compliance/sanctions";
import { MockTravelRuleProvider } from "../src/compliance/travelRule";
import {
  MockLimitsProvider,
  type MockLimitsProviderOptions,
} from "../src/compliance/limits";
import { StellarSigner } from "../src/stellar/signer";

type LimitsOverrides = {
  limits?: Parameters<typeof makeTxApproveHandler>[0]["limits"];
  kyc?: Parameters<typeof makeTxApproveHandler>[0]["kyc"];
  sanctions?: Parameters<typeof makeTxApproveHandler>[0]["sanctions"];
  travelRule?: Parameters<typeof makeTxApproveHandler>[0]["travelRule"];
};

/** KYC provider override that always returns `verified`. */
const kycVerified = {
  status: () =>
    Promise.resolve({ kind: "verified" as const, level: "enhanced" as const }),
};

/** Sanctions provider override that always returns a CFSP hit. */
const sanctionsHit = {
  hit: () =>
    Promise.resolve({
      list: "EU_CFSP" as const,
      matched_field: "address" as const,
      matched_value: "mock",
    }),
};

/** Limits provider override that always throws (chain RPC outage). */
const limitsThrowing = {
  wouldExceed: () => Promise.reject(new Error("RPC down")),
};

function buildApp(
  limitsOpts: MockLimitsProviderOptions = {},
  overrides: LimitsOverrides = {}
) {
  const kyc = overrides.kyc ?? new MockKycProvider();
  const sanctions = overrides.sanctions ?? new MockSanctionsProvider();
  const limits = overrides.limits ?? new MockLimitsProvider(limitsOpts);
  const travelRule = overrides.travelRule ?? new MockTravelRuleProvider();
  const signer = new StellarSigner(Keypair.random());

  const app = express();
  app.use(express.json());
  app.post(
    "/tx-approve",
    makeTxApproveHandler({
      kyc,
      sanctions,
      limits,
      travelRule,
      signer,
      networkPassphrase: Networks.TESTNET,
      approvalTtlLedgers: 17_280,
    })
  );
  return { app };
}

/** Build a minimal valid payment-style XDR for testing. */
function buildXdr(source: string): string {
  const account = new Account(source, "0");
  const dest = Keypair.random().publicKey();
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: dest, asset: Asset.native(), amount: "1" })
    )
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

/** Build a payment op with a custom (large) amount for ordering tests. */
function buildLargeXdr(source: string, amountUnscaled: bigint): string {
  const account = new Account(source, "0");
  const dest = Keypair.random().publicKey();
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: dest,
        asset: Asset.native(),
        amount: amountUnscaled.toString(),
      })
    )
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

describe("POST /tx-approve", () => {
  it("approves a clean transaction from a verified, non-sanctioned address", async () => {
    const { app } = buildApp({}, { kyc: kycVerified });
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(typeof res.body.tx).toBe("string");
    expect(res.body.expires_at_ledger).toBe(0);
  });

  it("rejects a sanctions hit", async () => {
    const { app } = buildApp(
      {},
      { kyc: kycVerified, sanctions: sanctionsHit }
    );
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("rejected");
    expect(res.body.error_code).toBe("SANCTIONS_HIT");
  });

  it("returns pending for an un-KYCed address", async () => {
    // Default MockKycProvider returns `pending` for addresses not
    // starting with "GVERIFIED"; a random keypair matches that branch.
    const { app } = buildApp();
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.action_required).toMatch(/^https:\/\/kyc\.example\.com/);
  });

  it("returns invalid for malformed XDR", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: "not-base64-or-xdr" });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("invalid");
    expect(res.body.error_code).toBe("INVALID_TX");
  });

  it("returns invalid when tx field is missing", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/tx-approve").send({});
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("invalid");
    expect(res.body.error_code).toBe("INVALID_TX");
  });

  // ── Velocity-limit wiring (MiCAR Art. 46) ─────────────────────────────────

  it("rejects when the velocity limit would be exceeded (MiCAR Art. 46)", async () => {
    const { app } = buildApp({ forceExceed: true }, { kyc: kycVerified });
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("rejected");
    expect(res.body.error_code).toBe("VELOCITY_EXCEEDED");
    expect(res.body.details).toBeDefined();
    expect(typeof res.body.details.additional_amount).toBe("string");
  });

  it("velocity check is reachable: input amount is recovered from the payment op", async () => {
    // 5M cur + 10M additional = 15M > 10M override → reject with
    // additional_amount showing the 10M we recovered from the
    // payment op (1 XLM at 7 dp).
    const source = Keypair.random().publicKey();
    const limits = new MockLimitsProvider({
      perAddressLimit: new Map([[source, 10_000_000n]]),
      currentOutflow: new Map([[source, 5_000_000n]]),
    });
    const { app } = buildApp({}, { kyc: kycVerified, limits });
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(source) });
    expect(res.body.error_code).toBe("VELOCITY_EXCEEDED");
    expect(res.body.details.additional_amount).toBe("10000000");
  });

  it("velocity check passes when projected volume is under the limit", async () => {
    const source = Keypair.random().publicKey();
    const limits = new MockLimitsProvider({
      perAddressLimit: new Map([[source, 100_000_000n]]),
      currentOutflow: new Map([[source, 0n]]),
    });
    const { app } = buildApp({}, { kyc: kycVerified, limits });
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(source) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("velocity short-circuits before travel-rule when both would reject", async () => {
    const { app } = buildApp({ forceExceed: true }, { kyc: kycVerified });
    // 100_000_000n = 10 EUREMT at 7 dp — comfortably under the SDK's
    // payment-amount validator cap (7 decimal places) and well above
    // the MockTravelRuleProvider's 100 EUREMT (1e9) threshold so the
    // travel-rule is also triggered below this. Velocity short-
    // circuits before travel-rule either way.
    const largeAmount = 100_000_000_000n;
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildLargeXdr(Keypair.random().publicKey(), largeAmount) });
    expect(res.body.error_code).toBe("VELOCITY_EXCEEDED");
  });

  it("velocity runs after sanctions (sanctions takes precedence)", async () => {
    // Inject a sanctions hit to demonstrate the pipeline ordering —
    // sanctions runs first, so velocity never sees the request.
    const { app } = buildApp(
      { forceExceed: true },
      { kyc: kycVerified, sanctions: sanctionsHit }
    );
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.body.error_code).toBe("SANCTIONS_HIT");
  });

  it("velocity runs after KYC pending (200 pending short-circuits first)", async () => {
    // Default MockKycProvider returns `pending` for unknown addresses;
    // forceExceed is set but the kyc short-circuit preempts it.
    const { app } = buildApp({ forceExceed: true });
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.body.status).toBe("pending");
    expect(res.body.error_code).toBeUndefined();
  });

  it("velocity provider failure surfaces as INTERNAL_ERROR", async () => {
    // Custom provider that throws — exercise the wrapping branch.
    const appErr = express();
    appErr.use(express.json());
    appErr.post(
      "/tx-approve",
      makeTxApproveHandler({
        kyc: kycVerified,
        sanctions: new MockSanctionsProvider(),
        limits: limitsThrowing,
        travelRule: new MockTravelRuleProvider(),
        signer: new StellarSigner(Keypair.random()),
        networkPassphrase: Networks.TESTNET,
        approvalTtlLedgers: 17_280,
      })
    );
    const res = await request(appErr)
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(500);
    expect(res.body.status).toBe("error");
    expect(res.body.error_code).toBe("INTERNAL_ERROR");
  });
});
