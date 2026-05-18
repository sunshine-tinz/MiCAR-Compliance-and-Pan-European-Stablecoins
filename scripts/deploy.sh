#!/usr/bin/env bash
# deploy.sh — Deploy EMT contracts to Stellar testnet
#
# Prerequisites:
#   - stellar CLI installed (https://developers.stellar.org/docs/tools/stellar-cli)
#   - Rust + wasm32-unknown-unknown target installed
#   - ADMIN_SECRET, MINTER_SECRET, PAUSER_SECRET, BLOCKLISTER_SECRET env vars set
#
# Usage:
#   ADMIN_SECRET=S... ./scripts/deploy.sh
#
# TODO for Contributors:
#   - Add mainnet deployment guard (require --network mainnet flag explicitly)
#   - Add contract upgrade script (Soroban contract update flow)
#   - Add verification step: call `name()` after deploy to confirm

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

echo "==> Building contracts..."
cd contracts
cargo build --release --target wasm32-unknown-unknown
cd ..

WASM_DIR="contracts/target/wasm32-unknown-unknown/release"

echo "==> Deploying emt_token..."
EMT_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_DIR/emt_token.wasm" \
  --source "$ADMIN_SECRET" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE")
echo "EMT_CONTRACT_ID=$EMT_CONTRACT_ID"

echo "==> Deploying compliance_hook..."
HOOK_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_DIR/compliance_hook.wasm" \
  --source "$ADMIN_SECRET" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE")
echo "HOOK_CONTRACT_ID=$HOOK_CONTRACT_ID"

echo "==> Deploying oracle_interface..."
ORACLE_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_DIR/oracle_interface.wasm" \
  --source "$ADMIN_SECRET" \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE")
echo "ORACLE_CONTRACT_ID=$ORACLE_CONTRACT_ID"

echo ""
echo "==> Deployment complete. Save these contract IDs:"
echo "EMT_CONTRACT_ID=$EMT_CONTRACT_ID"
echo "HOOK_CONTRACT_ID=$HOOK_CONTRACT_ID"
echo "ORACLE_CONTRACT_ID=$ORACLE_CONTRACT_ID"
echo ""
echo "==> Next: run scripts/initialize.sh to configure roles"
