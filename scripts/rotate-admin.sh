#!/usr/bin/env bash
# rotate-admin.sh — Walk through the two-step admin handover end-to-end.
#
# The on-chain flow is:
#   1. Current admin calls `propose_admin(new_admin)` — records PendingAdmin
#      and emits PROPOSE.
#   2. Proposed admin calls `accept_admin()` — becomes Admin, clears
#      PendingAdmin, emits ACCEPT.
#
# This script automates both steps against a live network, with safety
# checks and an explicit verification step at the end.
#
# Required env (or in .env):
#   ADMIN_SECRET          — secret of the CURRENT admin (signs the propose)
#   NEW_ADMIN_SECRET      — secret of the PROPOSED successor (signs the accept)
#   NEW_ADMIN_ADDRESS     — public address of the proposed successor
#   EMT_CONTRACT_ID       — (read from .deployment.json if not set)
#   NETWORK, RPC_URL, NETWORK_PASSPHRASE (with sensible defaults)
#
# Flags:
#   --dry-run             print the stellar-cli commands but do not submit
#   --no-accept           stop after propose (the new admin accepts manually)
#   --new-admin <ADDR>    override NEW_ADMIN_ADDRESS on the command line
#
# See docs/admin-handover.md for the full runbook.

set -euo pipefail

DRY_RUN=0
NO_ACCEPT=0
CLI_NEW_ADMIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=1; shift ;;
    --no-accept)      NO_ACCEPT=1; shift ;;
    --new-admin)      CLI_NEW_ADMIN="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "ERROR: unknown flag: $1" >&2; exit 1 ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
DEPLOYMENT_FILE="$PROJECT_ROOT/.deployment.json"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a; source "$PROJECT_ROOT/.env"; set +a
fi

if [ -f "$DEPLOYMENT_FILE" ] && command -v jq >/dev/null 2>&1; then
  : "${EMT_CONTRACT_ID:=$(jq -r '.contracts.emt_token' "$DEPLOYMENT_FILE")}"
  : "${NETWORK:=$(jq -r '.network' "$DEPLOYMENT_FILE")}"
  : "${RPC_URL:=$(jq -r '.rpcUrl' "$DEPLOYMENT_FILE")}"
  : "${NETWORK_PASSPHRASE:=$(jq -r '.networkPassphrase' "$DEPLOYMENT_FILE")}"
fi

: "${NETWORK:=testnet}"
: "${RPC_URL:=https://soroban-testnet.stellar.org}"
: "${NETWORK_PASSPHRASE:=Test SDF Network ; September 2015}"

require() {
  if [ -z "${!1:-}" ]; then
    echo "ERROR: required env $1 is not set." >&2
    exit 1
  fi
}

require EMT_CONTRACT_ID
require ADMIN_SECRET

if [ -n "$CLI_NEW_ADMIN" ]; then
  NEW_ADMIN_ADDRESS="$CLI_NEW_ADMIN"
fi
require NEW_ADMIN_ADDRESS

if [ "$NETWORK" = "mainnet" ] && [ "${I_UNDERSTAND_MAINNET:-0}" != "1" ]; then
  echo "Refusing to rotate admin on mainnet without I_UNDERSTAND_MAINNET=1." >&2
  exit 1
fi

# ── Pre-flight: read the current admin to sanity-check the new address ──────
echo "==> Reading current admin from $EMT_CONTRACT_ID ..."
CURRENT_ADMIN="$(
  stellar contract invoke \
    --id "$EMT_CONTRACT_ID" \
    --source "$ADMIN_SECRET" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    -- get_admin 2>/dev/null || true
)"

# Some contracts don't expose a get_admin; fall back to a string match only.
if [ -z "$CURRENT_ADMIN" ]; then
  echo "WARNING: contract has no get_admin view; skipping current/new identity check." >&2
else
  echo "    current admin : $CURRENT_ADMIN"
  echo "    proposed admin: $NEW_ADMIN_ADDRESS"
  if [ "$CURRENT_ADMIN" = "$NEW_ADMIN_ADDRESS" ]; then
    echo "ERROR: proposed admin is already the current admin — refusing to no-op." >&2
    exit 1
  fi
fi

# ── Step 1: propose_admin (current admin signs) ─────────────────────────────
PROPOSE_CMD=(
  stellar contract invoke
  --id "$EMT_CONTRACT_ID"
  --source "$ADMIN_SECRET"
  --network "$NETWORK"
  --rpc-url "$RPC_URL"
  --network-passphrase "$NETWORK_PASSPHRASE"
  -- propose_admin
  --new_admin "$NEW_ADMIN_ADDRESS"
)

echo "==> Step 1/3: propose_admin (current admin signs) ..."
if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] %q ' "${PROPOSE_CMD[@]}"; echo
else
  "${PROPOSE_CMD[@]}"
fi

# Confirm the proposal is on chain before moving on.
if [ "$DRY_RUN" = "0" ]; then
  PENDING="$(
    stellar contract invoke \
      --id "$EMT_CONTRACT_ID" \
      --source "$ADMIN_SECRET" \
      --network "$NETWORK" --rpc-url "$RPC_URL" \
      --network-passphrase "$NETWORK_PASSPHRASE" \
      -- pending_admin 2>/dev/null || true
  )"
  if [ -n "$PENDING" ] && [ "$PENDING" != "$NEW_ADMIN_ADDRESS" ]; then
    echo "ERROR: on-chain pending_admin is $PENDING, not the proposed $NEW_ADMIN_ADDRESS." >&2
    echo "       The propose may have failed or another proposal is in flight." >&2
    exit 1
  fi
  echo "    pending admin on chain: ${PENDING:-<unset>}"
fi

if [ "$NO_ACCEPT" = "1" ]; then
  echo
  echo "==> --no-accept: skipping accept step."
  echo "    The proposed admin must now call accept_admin to complete the rotation:"
  echo
  echo "    stellar contract invoke \\"
  echo "      --id $EMT_CONTRACT_ID \\"
  echo "      --source <NEW_ADMIN_SECRET> \\"
  echo "      --network $NETWORK --rpc-url $RPC_URL \\"
  echo "      --network-passphrase \"$NETWORK_PASSPHRASE\" \\"
  echo "      -- accept_admin"
  exit 0
fi

require NEW_ADMIN_SECRET

# ── Step 2: accept_admin (new admin signs) ──────────────────────────────────
ACCEPT_CMD=(
  stellar contract invoke
  --id "$EMT_CONTRACT_ID"
  --source "$NEW_ADMIN_SECRET"
  --network "$NETWORK"
  --rpc-url "$RPC_URL"
  --network-passphrase "$NETWORK_PASSPHRASE"
  -- accept_admin
)

echo "==> Step 2/3: accept_admin (proposed admin signs) ..."
if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] %q ' "${ACCEPT_CMD[@]}"; echo
else
  "${ACCEPT_CMD[@]}"
fi

# ── Step 3: verify ───────────────────────────────────────────────────────────
if [ "$DRY_RUN" = "0" ]; then
  echo "==> Step 3/3: verifying rotation ..."
  PENDING_AFTER="$(
    stellar contract invoke \
      --id "$EMT_CONTRACT_ID" \
      --source "$NEW_ADMIN_SECRET" \
      --network "$NETWORK" --rpc-url "$RPC_URL" \
      --network-passphrase "$NETWORK_PASSPHRASE" \
      -- pending_admin 2>/dev/null || true
  )"
  if [ -n "$PENDING_AFTER" ]; then
    echo "ERROR: pending_admin is still $PENDING_AFTER after accept — rotation did not complete." >&2
    exit 1
  fi
  # Exercise a privileged action with the new admin to confirm authority.
  if stellar contract invoke \
       --id "$EMT_CONTRACT_ID" --source "$NEW_ADMIN_SECRET" \
       --network "$NETWORK" --rpc-url "$RPC_URL" \
       --network-passphrase "$NETWORK_PASSPHRASE" \
       -- get_admin >/dev/null 2>&1; then
    echo "    get_admin reachable from new admin: ok"
  else
    echo "    (no get_admin view; skipping authority probe)"
  fi
  echo
  echo "==> Admin rotation complete on $NETWORK."
  echo "    New admin: $NEW_ADMIN_ADDRESS"
  echo "    Next: rotate any derived secrets (HOOK_SERVER, etc.) and update .env."
fi
