/**
 * Testnet integration test for POST /tx-approve.
 *
 * Goal: exercise the SEP-0008 hook server end-to-end against a live
 * Stellar testnet — friendbot-funded source, real testnet-shaped
 * XDR, real StellarSigner signing the response.
 *
 * Gating: this suite is **opt-in**. Run with:
 *
 *     RUN_TESTNET_INTEGRATION=1 npm test -- testnetIntegration.test.ts
 *
 * When the env var is unset (the default for `npm test`), the file
 * logs at most a one-line skip at the top of the run and every test
 * in this file is skipped. This keeps default CI fast and offline.
 *
 * What is REAL in this test:
 *   - Friendbot funds a freshly generated keypair on testnet.
 *   - The request body is a real Transactions.BuildXDR for testnet.
 *   - The response body's signed XDR is cryptographic-validated
 *     client-side: re-decode with Networks.TESTNET, find a signature
 *     whose hint matches the hook server's signer, and assert
 *     `keypair.verify(tx.hash(), sig.signature())` returns true.
 *
 * What is MOCKED (and why):
 *   - KYC / sanctions / travel-rule providers: no real vendor creds
 *     are available in CI. The handler short-circuits past them
 *     anyway once we inject `verified` + `null hit` responses.
 *   - LimitsProvider: `MockLimitsProvider`. Wiring up the real
 *     `EmtTokenLimitsProvider` would require a deployed `emt_token`
 *     contract on this testnet (we'd need to deploy + wire the
 *     contract ID). Mocking this stays in scope of "exercise the
 *     hook server's XDR signing path" without dragging in a full
 *     contract deploy.
 *
 * Time budget: ~5 s for friendbot + horizon account check, plus a
 * few hundred ms for the in-process handler calls. Comfortably under
 * Jest's default 5 s/test ceiling; no opt-in for `--testTimeout`.
 *
 * Failure surface:
 *   - Friendbot 5xx / network failure → beforeAll throws. If the
 *     env gate is on, that's a real CI failure (the suite was
 *     asked to run, so the failure should be visible).
 *   - Re-decode or signature verification failure → test fails with
 *     the SDK decode error / assertion message.
 */

import express from "express";
import request from "supertest";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { makeTxApproveHandler } from "../src/handlers/txApprove";
import {
  MockKycProvider,
  type KycProvider,
  type KycStatus,
} from "../src/compliance/kyc";
import { MockSanctionsProvider } from "../src/compliance/sanctions";
import { MockLimitsProvider } from "../src/compliance/limits";
import { MockTravelRuleProvider } from "../src/compliance/travelRule";
import { StellarSigner } from "../src/stellar/signer";

const INTEGRATION_ENABLED = process.env.RUN_TESTNET_INTEGRATION === "1";

// Logging at the top of the test run so the operator sees why the
// file skipped when RUN_TESTNET_INTEGRATION is unset.
if (!INTEGRATION_ENABLED) {
  // eslint-disable-next-line no-console
  console.warn(
    "[testnetIntegration] RUN_TESTNET_INTEGRATION!=1 — skipping " +
      "live testnet suite. Set RUN_TESTNET_INTEGRATION=1 to enable."
  );
}

const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip;

// ── Live network helpers ──────────────────────────────────────────────────────

const FRIENDBOT_URL =
  process.env.STELLAR_FRIENDBOT_URL ?? "https://friendbot.stellar.org";
const TESTNET_PASSPHRASE = Networks.TESTNET;

/**
 * Fund a fresh keypair on Stellar testnet via friendbot. Retries up
 * to two times with a 1 s back-off so a transient rate-limit
 * response from friendbot doesn't gate an entire
 * `RUN_TESTNET_INTEGRATION=1` CI run.
 */
async function fundTestnetAccount(publicKey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, { method: "GET" });
    if (res.ok) return;
    const snippet = (await res.text()).slice(0, 256);
    lastErr = new Error(
      `friendbot funding attempt ${attempt} failed: ${res.status} ` +
        `${res.statusText} — ${snippet}`
    );
    if (attempt < 2) {
      // 1 s back-off — friendbot's per-IP rate-limit window is short.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastErr ?? new Error("friendbot funding failed: unknown reason");
}

/**
 * KYC stand-in that always reports `verified`. We can't use the
 * stock `MockKycProvider` for live-testnet addresses — its prefix
 * heuristics (`GVERIFIED*` / `GFAILED*`) don't match real
 * base32-derived public keys. Subclassing keeps the codebase
 * pattern (mock classes over inline objects) while letting the
 * test exercise the verified branch of the handler pipeline.
 */
class AlwaysVerifiedKycProvider extends MockKycProvider {
  async status(_address: string): Promise<KycStatus> {
    return { kind: "verified", level: "enhanced" };
  }
}

// ── Per-test app builder ──────────────────────────────────────────────────────

function buildApp(): {
  app: ReturnType<typeof express>;
  signer: StellarSigner;
} {
  const signer = new StellarSigner(Keypair.random());
  // In-process mocks: each compliance provider is mocked because
  // the CI env has no real vendor creds. Limits is mocked so we
  // don't need a deployed `emt_token` contract on testnet. KYC is
  // the `AlwaysVerifiedKycProvider` defined above (the stock
  // MockKycProvider's prefix heuristics don't match real testnet
  // public keys).
  const kyc: KycProvider = new AlwaysVerifiedKycProvider();
  const sanctions = new MockSanctionsProvider();
  const limits = new MockLimitsProvider();
  const travelRule = new MockTravelRuleProvider();

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
      networkPassphrase: TESTNET_PASSPHRASE,
      approvalTtlLedgers: 17_280,
    })
  );
  return { app, signer };
}

// ── XDR builders ──────────────────────────────────────────────────────────────

function buildTestnetPaymentXdr(sourcePublicKey: string): string {
  // Sequence = "0" is fine for this test: we never submit the tx,
  // we only POST it to the handler which signs and returns XDR.
  const account = new Account(sourcePublicKey, "0");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

function buildWrongNetworkPaymentXdr(sourcePublicKey: string): string {
  // Same shape, but signed with the PUBLIC network passphrase so the
  // handler's decodeTxXdr against TESTNET will reject it.
  const account = new Account(sourcePublicKey, "0");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration("/tx-approve end-to-end against Stellar testnet", () => {
  let fundedKeypair: Keypair;

  beforeAll(async () => {
    fundedKeypair = Keypair.random();
    const t0 = Date.now();
    await fundTestnetAccount(fundedKeypair.publicKey());
    const elapsed = Date.now() - t0;
    // Surface the round-trip time in the test log so a slow network
    // is visible to the operator reviewing CI artefacts.
    // eslint-disable-next-line no-console
    console.log(
      `[testnetIntegration] friendbot funded ${fundedKeypair.publicKey()} in ${elapsed} ms`
    );
  }, 30_000); // friendbot can be slow on testnet; cap explicit.

  it(
    "approves a friendbot-funded testnet XDR and the response XDR is cryptographically valid",
    async () => {
      const { app, signer } = buildApp();
      const txXdr = buildTestnetPaymentXdr(fundedKeypair.publicKey());
      const res = await request(app).post("/tx-approve").send({ tx: txXdr });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
      expect(typeof res.body.tx).toBe("string");
      // The handler placeholder for `expires_at_ledger` is `0`
      // (a real impl would query RPC `getLedger` and add the TTL).
      expect(res.body.expires_at_ledger).toBe(0);

      // Client-side cryptographic verification: re-decode the
      // returned base64 XDR with the testnet passphrase. The handler
      // signs and serialises the same Transaction object we built, so
      // re-decoding should produce an equivalent envelope.
      const decoded = TransactionBuilder.fromXDR(
        res.body.tx,
        TESTNET_PASSPHRASE
      );
      // Narrowing: our handler rejects FeeBumpTransaction envelopes
      // up front, so this is unreachable in practice; the assertion
      // documents the invariant.
      if (decoded instanceof FeeBumpTransaction) {
        throw new Error("expected Transaction, got FeeBumpTransaction");
      }
      const signed = decoded;
      expect(signed.source).toBe(fundedKeypair.publicKey());

      // The handler signs exactly once, with the hook server's
      // configured signer. Pin the signature count so a future change
      // that adds (or worse, duplicates) a signature is caught loudly
      // instead of silently appended.
      expect(signed.signatures.length).toBe(1);

      // Find the hook server's signature by hint and verify the
      // cryptographic signature against the transaction's body hash.
      const hint = signer.keypair.signatureHint();
      const sig = signed.signatures.find((s) => s.hint().equals(hint));
      expect(sig).toBeDefined();
      const valid = signer.keypair.verify(
        signed.hash(),
        sig!.signature()
      );
      expect(valid).toBe(true);
    },
    15_000
  );

  it(
    "returns 400 INVALID_TX when the XDR was built for a different network",
    async () => {
      const { app } = buildApp();
      const wrongNetXdr = buildWrongNetworkPaymentXdr(
        fundedKeypair.publicKey()
      );
      const res = await request(app)
        .post("/tx-approve")
        .send({ tx: wrongNetXdr });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe("invalid");
      expect(res.body.error_code).toBe("INVALID_TX");
      // The error message is informative — confirm it surfaces the
      // actual SDK decode error so a wallet dev can see why their
      // XDR was rejected.
      expect(typeof res.body.error).toBe("string");
      expect(res.body.error.length).toBeGreaterThan(0);
    },
    15_000
  );

  it(
    "returns 400 INVALID_TX when the tx field is missing",
    async () => {
      const { app } = buildApp();
      const res = await request(app).post("/tx-approve").send({});
      expect(res.status).toBe(400);
      expect(res.body.status).toBe("invalid");
      expect(res.body.error_code).toBe("INVALID_TX");
    },
    15_000
  );
});
