/**
 * Integration test for POST /tx-approve.
 *
 * Boots the Express app in-process (no `listen()` call here — we
 * hand the app to supertest instead) and exercises the happy path
 * plus the four documented rejection paths.
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
import { MockLimitsProvider } from "../src/compliance/limits";
import { StellarSigner } from "../src/stellar/signer";

function buildApp() {
  const kyc = new MockKycProvider();
  const sanctions = new MockSanctionsProvider();
  const limits = new MockLimitsProvider();
  const travelRule = new MockTravelRuleProvider();
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
  return { app, signer, kyc, sanctions };
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

describe("POST /tx-approve", () => {
  it("approves a clean transaction from a verified, non-sanctioned address", async () => {
    const { app } = buildApp();
    const verifiedSource = "GVERIFIED" + "X".repeat(48);
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(verifiedSource) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(typeof res.body.tx).toBe("string");
    expect(res.body.expires_at_ledger).toBe(0);
  });

  it("rejects a sanctions hit", async () => {
    const { app } = buildApp();
    const sanctioned = "GSANCTIONED" + "X".repeat(46);
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(sanctioned) });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("rejected");
    expect(res.body.error_code).toBe("SANCTIONS_HIT");
  });

  it("returns pending for an un-KYCed address", async () => {
    const { app } = buildApp();
    const unkyc = "G" + "A".repeat(55);
    const res = await request(app)
      .post("/tx-approve")
      .send({ tx: buildXdr(unkyc) });
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
});
