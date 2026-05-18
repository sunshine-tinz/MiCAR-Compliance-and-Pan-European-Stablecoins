#!/usr/bin/env bash
# initialize.sh — Initialize deployed EMT contracts with roles
#
# Run after deploy.sh. Requires the contract IDs from that script.
#
# Usage:
#   EMT_CONTRACT_ID=C... HOOK_CONTRACT_ID=C... ORACLE_CONTRACT_ID=C... \
#   ADMIN_SECRET=S... MINTER_ADDRESS=G... PAUSER_ADDRESS=G... \
#   BLOCKLISTER_ADDRESS=G... HOOK_SERVER_ADDRESS=G... \
#   ./scripts/initialize.sh

set -euo pipefail

NETWORK="${NETWORK:-testnet}"

echo "==> Initializing emt_token..."
stellar contract invoke \
  --id "$EMT_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --minter "$MINTER_ADDRESS" \
  --pauser "$PAUSER_ADDRESS" \
  --blocklister "$BLOCKLISTER_ADDRESS"

echo "==> Initializing compliance_hook..."
stellar contract invoke \
  --id "$HOOK_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --hook_server "$HOOK_SERVER_ADDRESS"

echo "==> Initializing oracle_interface..."
stellar contract invoke \
  --id "$ORACLE_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_ADDRESS"

echo "==> All contracts initialized."
