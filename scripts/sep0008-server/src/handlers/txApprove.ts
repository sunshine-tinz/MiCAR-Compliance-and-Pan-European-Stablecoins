/**
 * POST /tx-approve handler.
 *
 * Wires the four compliance providers and the Stellar signer into a
 * clean decision flow. Returns one of the five response shapes
 * documented in docs/sep0008-hook.md §2.1.
 *
 * Pipeline order (deliberate, see docs/sep0008-hook.md §1):
 *   1. body validation       → 400 INVALID_TX
 *   2. XDR decode            → 400 INVALID_TX
 *   3. sanctions             → 400 SANCTIONS_HIT
 *   4. KYC                   → 200 pending / 400 KYC_FAILED
 *   5. velocity (MiCAR 46)   → 400 VELOCITY_EXCEEDED  ← NEW
 *   6. travel-rule (MiCAR 22)→ 400 TRAVEL_RULE_MISSING
 *   7. sign and return       → 200 approved
 *
 * Velocity runs before travel-rule because the travel-rule threshold
 * check needs the same transfer amount we'd already extract for the
 * velocity projection, and because the off-chain per-address limit is
 * a cleaner deny / approve than constructing originator data the
 * issuer wouldn't accept anyway.
 */

import { Request, Response } from "express";
import type { KycProvider } from "../compliance/kyc";
import type { SanctionsProvider } from "../compliance/sanctions";
import type { LimitsProvider } from "../compliance/limits";
import type { TravelRuleProvider } from "../compliance/travelRule";
import type { StellarSigner } from "../stellar/signer";
import { decodeTxXdr, extractTransferAmount } from "../stellar/decoder";
import type { TxApproveRequest, TxApproveResponse } from "../types";

export interface TxApproveDeps {
  kyc: KycProvider;
  sanctions: SanctionsProvider;
  limits: LimitsProvider;
  travelRule: TravelRuleProvider;
  signer: StellarSigner;
  networkPassphrase: string;
  approvalTtlLedgers: number;
}

export function makeTxApproveHandler(deps: TxApproveDeps) {
  return async function txApprove(req: Request, res: Response): Promise<void> {
    const body = req.body as Partial<TxApproveRequest> | undefined;
    if (!body || typeof body.tx !== "string") {
      const r: TxApproveResponse = {
        status: "invalid",
        error_code: "INVALID_TX",
        error: "request body must include `tx` (base64 XDR)",
      };
      res.status(400).json(r);
      return;
    }

    const decoded = decodeTxXdr(body.tx, deps.networkPassphrase);
    if (!decoded.ok) {
      const r: TxApproveResponse = {
        status: "invalid",
        error_code: "INVALID_TX",
        error: `XDR could not be decoded: ${decoded.error}`,
      };
      res.status(400).json(r);
      return;
    }

    const { tx, hash: _hash } = decoded;
    // `_hash` is the SHA-256 of the unsigned envelope XDR — the same
    // value the on-chain `compliance_hook.approve_transaction` expects.
    // The skeleton doesn't record on-chain approvals yet; the binding
    // is kept so a future wiring can call `complianceHook.approve(_hash)`
    // after the sign step below. See docs/sep0008-hook.md §7.
    // Note: extracting the source / operations from a generic
    // Transaction requires walking the envelope. The reference impl
    // treats every operation as a Soroban invoke against the EMT
    // contract, which is the supported use case for this repo.
    const sourceAddress = tx.source;

    // ── Sanctions check ───────────────────────────────────────────────────
    const sanctionsHit = await deps.sanctions.hit(sourceAddress);
    if (sanctionsHit) {
      const r: TxApproveResponse = {
        status: "rejected",
        error_code: "SANCTIONS_HIT",
        error: `Sender ${sourceAddress} is on the ${sanctionsHit.list} sanctions list`,
        details: { ...sanctionsHit },
      };
      res.status(400).json(r);
      return;
    }

    // ── KYC check ─────────────────────────────────────────────────────────
    const kyc = await deps.kyc.status(sourceAddress);
    if (kyc.kind === "pending") {
      const r: TxApproveResponse = {
        status: "pending",
        error: "KYC verification required",
        action_required: kyc.action_url,
      };
      res.status(200).json(r);
      return;
    }
    if (kyc.kind === "failed") {
      const r: TxApproveResponse = {
        status: "rejected",
        error_code: "KYC_FAILED",
        error: `KYC failed: ${kyc.reason}`,
      };
      res.status(400).json(r);
      return;
    }

    // ── Velocity check (MiCAR Art. 46) ────────────────────────────────────
    // `extractTransferAmount` returns `null` when the operation isn't
    // recognizable (e.g. CreateAccount, ManageData). Treat that as
    // "no outgoing volume to assert" and skip the check — the
    // downstream contracts will reject any non-transfer op against
    // the EMT contract anyway. `additionalAmount = 0n` also makes the
    // check a no-op for ops whose amount can't be recovered, which
    // matches the pre-wiring behaviour.
    const additionalAmount = extractTransferAmount(tx) ?? 0n;
    let velocityExceeded: boolean;
    try {
      velocityExceeded = await deps.limits.wouldExceed(
        sourceAddress,
        additionalAmount
      );
    } catch (err) {
      // Chain-driven providers can throw on RPC outages / simulation
      // errors. Surface these as the documented `INTERNAL_ERROR` shape
      // (spec §2.1 / §3) instead of leaking a generic Express 500 with
      // no JSON body.
      const r: TxApproveResponse = {
        status: "error",
        error_code: "INTERNAL_ERROR",
        error: `velocity provider failed: ${(err as Error).message}`,
      };
      res.status(500).json(r);
      return;
    }
    if (velocityExceeded) {
      const r: TxApproveResponse = {
        status: "rejected",
        error_code: "VELOCITY_EXCEEDED",
        error: "Transfer would exceed the per-address 24h velocity limit",
        details: {
          address: sourceAddress,
          additional_amount: additionalAmount.toString(),
        },
      };
      res.status(400).json(r);
      return;
    }

    // ── Travel-rule check ─────────────────────────────────────────────────
    // The travel-rule threshold check needs the same transfer amount we
    // just extracted for the velocity projection; pass it through.
    const travelRuleMissing = await deps.travelRule.missingData(
      additionalAmount,
      body.originator,
      body.beneficiary
    );
    if (travelRuleMissing) {
      const r: TxApproveResponse = {
        status: "rejected",
        error_code: "TRAVEL_RULE_MISSING",
        error: `Travel-rule data missing fields: ${travelRuleMissing}`,
      };
      res.status(400).json(r);
      return;
    }

    // ── All checks passed — sign and return ───────────────────────────────
    deps.signer.sign(tx);
    const expiresAtLedger =
      // Placeholder: a real impl would query the current ledger
      // sequence from the RPC and add APPROVAL_TTL_LEDGERS. For
      // now, return 0 to indicate "no on-chain approval recorded".
      0;

    const r: TxApproveResponse = {
      status: "approved",
      tx: tx.toXDR(),
      expires_at_ledger: expiresAtLedger,
    };
    res.status(200).json(r);
  };
}
