# Admin Handover Runbook

This document describes the two-step admin handover flow for the MiCAR
Euro EMT token. The on-chain primitive is `propose_admin(new_admin)` +
`accept_admin()`, both exposed by `contracts/emt_token/src/lib.rs` and
documented in the SDK as `proposeAdmin` / `acceptAdmin`. The flow is
augmented by an automation script at `scripts/rotate-admin.sh`.

## Why two steps?

A naive single-step `set_admin(new)` would let a compromised admin key
trivially hand the contract to an attacker. The two-step flow forces the
**proposed** successor to acknowledge the role with their own signature
before the change takes effect, so a stolen current-admin key cannot
silently hand over the contract without the successor's cooperation.

The three lifecycle events are:
- `PROPOSE(current_admin, proposed)` — emitted by `propose_admin`
- `ACCEPT(proposed)` — emitted by `accept_admin`
- `CANCEL(current_admin)` — emitted by `cancel_proposed_admin`

All three are visible on-chain for the 5-year MiCAR record-keeping
window (see [`docs/micar-compliance.md`](micar-compliance.md)).

## When to use

- **Scheduled key rotation** (e.g., quarterly) — the new admin key
  already exists and the operator is ready to accept.
- **Admin device change** — moving admin authority from a hardware
  wallet to a different one.
- **Recovery from suspected compromise** — see
  [Compromise recovery](#compromise-recovery) below.

Do **not** use this flow for:
- Minting / pausing / blocklisting / clawback — these are separate
  roles (`minter`, `pauser`, `blocklister`) and are rotated via
  `update_minter`, `update_pauser`, `update_blocklister` respectively.
- Rotating the off-chain hook server key — that's the
  `update_hook_server` entry on the `compliance_hook` contract.

## Step-by-step

The script automates all three steps. Manual invocations are shown
alongside for reference.

### Step 1 — Propose

The **current** admin records a successor:

```bash
stellar contract invoke \
  --id "$EMT_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- propose_admin \
  --new_admin "$NEW_ADMIN_ADDRESS"
```

Contract state: `pending_admin = Some(NEW_ADMIN_ADDRESS)`. The current
admin is unchanged.

If you re-call `propose_admin` with a different address, the new
address **overwrites** the pending one — no `accept_admin` is required
to clear the old proposal. To explicitly cancel without re-proposing,
use `cancel_proposed_admin`.

### Step 2 — Accept

The **proposed** successor acknowledges the role:

```bash
stellar contract invoke \
  --id "$EMT_CONTRACT_ID" \
  --source "$NEW_ADMIN_SECRET" \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- accept_admin
```

Contract state: `admin = NEW_ADMIN_ADDRESS`, `pending_admin = None`.
The event `ACCEPT(NEW_ADMIN_ADDRESS)` is emitted.

The successor's `require_auth()` is enforced by the host: the call
panics with `MissingValueForAuthContext` if no signature for
`$NEW_ADMIN_ADDRESS` is attached. This is what gives the flow its
security: the successor must *want* the role.

### Step 3 — Verify

Read back the on-chain state and exercise a privileged action with the
new admin key:

```bash
# Confirm the proposal was cleared
stellar contract invoke --id "$EMT_CONTRACT_ID" --source "$NEW_ADMIN_SECRET" \
  --network testnet --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" -- pending_admin
# expected output: empty / null (no pending proposal)

# Try a no-op privileged action (e.g. update_pauser with the same address)
stellar contract invoke --id "$EMT_CONTRACT_ID" --source "$NEW_ADMIN_SECRET" \
  --network testnet --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- update_pauser --new_pauser "$PAUSER_ADDRESS"
```

If the new admin's signature is rejected, do **not** assume the rotation
took effect. The `pending_admin` view is the source of truth.

## One-shot automation

The `scripts/rotate-admin.sh` script runs all three steps, with safety
checks and `--dry-run` / `--no-accept` modes:

```bash
# Preview (no transactions submitted)
./scripts/rotate-admin.sh --dry-run --new-admin "$NEW_ADMIN_ADDRESS"

# Propose only (the new admin accepts manually)
./scripts/rotate-admin.sh --no-accept --new-admin "$NEW_ADMIN_ADDRESS"

# Full rotation (current + new admin keys both in .env)
./scripts/rotate-admin.sh --new-admin "$NEW_ADMIN_ADDRESS"
```

The script refuses to run on mainnet unless `I_UNDERSTAND_MAINNET=1` is
set (same guard as `deploy.sh`).

## Failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| `propose_admin` panics with `"already admin"` | `new_admin == current admin` | Pick a different successor. |
| `propose_admin` panics with auth error | `ADMIN_SECRET` is not the current admin | Verify the secret. The contract tells you who the admin is via... well, it doesn't yet; add a `get_admin` view first. |
| `accept_admin` panics with `"no pending admin"` | No proposal in flight (or the previous one was cancelled) | Run step 1 again. |
| `accept_admin` panics with auth error | The signing keypair is not the **proposed** successor | Sign with `NEW_ADMIN_SECRET`. The contract calls `pending_admin.require_auth()` — only the proposed address works. |
| `pending_admin` returns a different address than expected | A previous `propose_admin` was overwritten, or a stale proposal is in flight | Re-run `propose_admin` with the intended address (this overwrites). |
| Rotation completed but old key still seems to work | The new admin's key is a *separate* secret; you may have updated `.env` but the on-chain role is now governed by `NEW_ADMIN_SECRET` | The old `ADMIN_SECRET` is **no longer privileged**. Treat it as compromised and rotate any derived keys. |

## Audit trail

Every handover produces two on-chain events. Indexers and off-chain
compliance tooling can reconstruct the full history:

```
ledger N    PROPOSE(GADMIN, NEWADMIN)
ledger N+k  ACCEPT(NEWADMIN)
```

If the proposal is cancelled instead:

```
ledger N    PROPOSE(GADMIN, CANDIDATE_A)
ledger N+m  CANCEL(GADMIN)
ledger N+o  PROPOSE(GADMIN, CANDIDATE_B)
```

This is the audit trail the compliance officer should reconcile against
the issuer's change-management system.

## Pre-flight checklist

Before invoking `rotate-admin.sh`:

- [ ] `NEW_ADMIN_ADDRESS` is a real Stellar address (G...) and is
      funded enough to cover the transaction fee.
- [ ] `NEW_ADMIN_SECRET` is the secret for `NEW_ADMIN_ADDRESS`. Test
      with `stellar keys address <NAME>`.
- [ ] The new admin's signer hardware / cloud KMS is online and ready
      to sign.
- [ ] A backout plan exists: if `accept_admin` fails, the proposal can
      be cancelled via `cancel_proposed_admin` from the *current* admin
      (which still has authority).
- [ ] On mainnet: `I_UNDERSTAND_MAINNET=1` is set in the environment.
- [ ] `.deployment.json` is up to date with the correct `EMT_CONTRACT_ID`.

## Compromise recovery

If the **current** admin key is suspected compromised:

1. **Don't panic.** The contract is not yet under attacker control
   unless the attacker can also produce the proposed successor's
   signature. The two-step design gives you a window.
2. From a **known-good** offline machine, propose a fresh admin
   address you control. This overwrites any in-flight proposal from
   the compromised key.
3. From the new admin's key, call `accept_admin`.
4. Once the rotation is confirmed (`pending_admin` returns empty),
   the compromised key is **no longer privileged**. You can leave it
   orphaned; do not reuse it.
5. Audit the off-chain side: check the `PROPOSE` and `ACCEPT` events
   for any rotations you did not initiate. The contract itself is
   not directly affected, but the SEP-0008 hook server and any
   operational tooling should be reviewed.
6. Consider rotating `Minter`, `Pauser`, `Blocklister`, and the
   `compliance_hook.HookServer` key as well — the compromised admin
   could have updated any of those.

If the **proposed** successor key is suspected compromised before
acceptance, the current admin should call `cancel_proposed_admin`
to clear the pending proposal. Then re-propose a clean successor.

## Reference

- `contracts/emt_token/src/lib.rs` — `propose_admin`, `accept_admin`,
  `cancel_proposed_admin`, `pending_admin` entries.
- `sdk/src/EmtClient.ts` — `proposeAdmin`, `acceptAdmin`,
  `cancelProposedAdmin`, `getPendingAdmin` methods.
- `scripts/rotate-admin.sh` — automation script.
- [`docs/architecture.md`](architecture.md) — role model overview.
- [`docs/micar-compliance.md`](micar-compliance.md) — Art. 35
  (issuer authorisation) and Art. 23 (audit trail) mapping.
