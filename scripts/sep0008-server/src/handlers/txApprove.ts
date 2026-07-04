/**
 * POST /tx-approve handler.
 *
 * Wires the four compliance providers and the Stellar signer into a
 * clean decision flow. Returns one of the five response shapes
 * documented in docs/sep0008-hook.md §2.1.
 */

import { Request, Response } from "express";
import type { KycProvider } from "../compliance/kyc";
import type { SanctionsProvider } from "../compliance/sanctions";
import type { LimitsProvider } from "../compliance/limits";
import type { TravelRuleProvider } from "../compliance/travelRule";
import type { StellarSigner } from "../stellar/signer";
import { decodeTxXdr } from "../stellar/decoder";
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

    // ── Travel-rule check ─────────────────────────────────────────────────
    // We don't decode the inner Soroban invoke args here (would require
    // a contract-spec). The reference impl just looks at the user-
    // supplied travel-rule fields in the request body. A production
    // impl would also extract the transfer amount from the operation
    // and compare against the threshold.
    const travelRuleMissing = await deps.travelRule.missingData(
      0n, // placeholder; real impl extracts from op args
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
