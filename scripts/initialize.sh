#!/usr/bin/env bash
# initialize.sh — Initialise the three EMT contracts with their roles.
#
# Picks up contract IDs from `.deployment.json` if present and addresses
# from `.env` if present. Required env (or in .env):
#
#   ADMIN_SECRET         — secret of the admin (source for invocation)
#   ADMIN_ADDRESS        — public address of the admin (passed to contract)
#   MINTER_ADDRESS       — …
#   PAUSER_ADDRESS       — …
#   BLOCKLISTER_ADDRESS  — …
#   HOOK_SERVER_ADDRESS  — …
#
# Optional:
#   EMT_CONTRACT_ID / HOOK_CONTRACT_ID / ORACLE_CONTRACT_ID
#     override values from `.deployment.json`
#   NETWORK, RPC_URL, NETWORK_PASSPHRASE
#     otherwise read from `.deployment.json` or default to testnet

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
DEPLOYMENT_FILE="$PROJECT_ROOT/.deployment.json"

if [ -f "$PROJECT_ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$PROJECT_ROOT/.env"; set +a
fi

if [ -f "$DEPLOYMENT_FILE" ]; then
  if command -v jq >/dev/null 2>&1; then
    : "${EMT_CONTRACT_ID:=$(jq -r '.contracts.emt_token' "$DEPLOYMENT_FILE")}"
    : "${HOOK_CONTRACT_ID:=$(jq -r '.contracts.compliance_hook' "$DEPLOYMENT_FILE")}"
    : "${ORACLE_CONTRACT_ID:=$(jq -r '.contracts.oracle_interface' "$DEPLOYMENT_FILE")}"
    : "${NETWORK:=$(jq -r '.network' "$DEPLOYMENT_FILE")}"
    : "${RPC_URL:=$(jq -r '.rpcUrl' "$DEPLOYMENT_FILE")}"
    : "${NETWORK_PASSPHRASE:=$(jq -r '.networkPassphrase' "$DEPLOYMENT_FILE")}"
  else
    echo "WARNING: jq not found; relying on explicit env vars" >&2
  fi
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
require HOOK_CONTRACT_ID
require ORACLE_CONTRACT_ID
require ADMIN_SECRET
require ADMIN_ADDRESS
require MINTER_ADDRESS
require PAUSER_ADDRESS
require BLOCKLISTER_ADDRESS
require HOOK_SERVER_ADDRESS

invoke() {
  local id="$1" fn="$2"
  shift 2
  echo "==> Calling $fn on $id ..."
  stellar contract invoke \
    --id "$id" \
    --source "$ADMIN_SECRET" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    -- "$fn" "$@"
}

invoke "$EMT_CONTRACT_ID" initialize \
  --admin "$ADMIN_ADDRESS" \
  --minter "$MINTER_ADDRESS" \
  --pauser "$PAUSER_ADDRESS" \
  --blocklister "$BLOCKLISTER_ADDRESS"

invoke "$HOOK_CONTRACT_ID" initialize \
  --admin "$ADMIN_ADDRESS" \
  --hook_server "$HOOK_SERVER_ADDRESS"

invoke "$ORACLE_CONTRACT_ID" initialize \
  --admin "$ADMIN_ADDRESS"

echo ""
echo "==> All contracts initialized on $NETWORK."
echo ""
# Sanity-check emt_token only — it's the only one of the three that
# exposes a current-admin read (`get_admin`). compliance_hook and
# oracle_interface don't expose their admin by design; the three
# `initialize` calls above are the canonical admin-reachability proof
# for those two. The previous loop probed every contract with a
# `get_role Admin` view that none of them exposed — it was dead code
# that always fell through to a warning.
echo "    emt_token get_admin (sanity check):"
if admin_addr="$(stellar contract invoke \
       --id "$EMT_CONTRACT_ID" --source "$ADMIN_SECRET" \
       --network "$NETWORK" --rpc-url "$RPC_URL" \
       --network-passphrase "$NETWORK_PASSPHRASE" \
       -- get_admin 2>/dev/null)"; then
  echo "      admin = $admin_addr"
else
  echo "      <get_admin failed — investigate RPC / contract state>"
fi
echo ""
echo "    Contract IDs (for off-chain tooling / dashboards):"
echo "      emt_token        = $EMT_CONTRACT_ID"
echo "      compliance_hook  = $HOOK_CONTRACT_ID"
echo "      oracle_interface = $ORACLE_CONTRACT_ID"
echo ""
echo "    Next step: ./scripts/verify.sh"
