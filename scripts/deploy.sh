#!/usr/bin/env bash
# deploy.sh — Build & deploy the three EMT contracts to a Stellar network.
#
# Required env (or a local .env, see .env.example):
#   ADMIN_SECRET         — secret key (S...) that funds deploys
#   NETWORK              — testnet | futurenet | mainnet  (default: testnet)
#   RPC_URL              — Soroban RPC URL
#   NETWORK_PASSPHRASE   — network passphrase
#
# Optional:
#   I_UNDERSTAND_MAINNET=<1>  required to deploy to mainnet (safety guard)
#   SKIP_BUILD=1               skip rebuild if wasm artifacts exist
#
# After success, contract IDs are saved to `.deployment.json` so
# `initialize.sh` and downstream tooling can pick them up automatically.

set -euo pipefail

if [ -f .env ]; then
  # Filter to bare `KEY=VALUE` lines so `set -u` does not blow up on comments
  # or blank lines, then export each variable.
  while IFS= read -r line; do
    case "$line" in
      ''|\#*) continue ;;
      *)      export "$line" ;;
    esac
  done < .env
fi

: "${ADMIN_SECRET:=}"
: "${NETWORK:=testnet}"
: "${RPC_URL:=https://soroban-testnet.stellar.org}"
: "${NETWORK_PASSPHRASE:=Test SDF Network ; September 2015}"

PROJECT_ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
WASM_DIR="$CONTRACTS_DIR/target/wasm32-unknown-unknown/release"
DEPLOYMENT_FILE="$PROJECT_ROOT/.deployment.json"

if [ -z "$ADMIN_SECRET" ]; then
  echo "ERROR: ADMIN_SECRET is not set." >&2
  echo "       See .env.example or export it directly before running." >&2
  exit 1
fi

if [ "$NETWORK" = "mainnet" ] && [ "${I_UNDERSTAND_MAINNET:-0}" != "1" ]; then
  echo "Refusing to deploy to mainnet." >&2
  echo "Set I_UNDERSTAND_MAINNET=1 if you really intend this." >&2
  exit 1
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Building contracts (this can take a few minutes on a cold cache)..."
  (cd "$CONTRACTS_DIR" && cargo build --release --target wasm32-unknown-unknown)
else
  echo "==> SKIP_BUILD=1 — assuming wasm artifacts are up to date"
fi

deploy_contract() {
  local name="$1"
  local wasm="$WASM_DIR/${name}.wasm"
  if [ ! -f "$wasm" ]; then
    echo "ERROR: missing build artifact $wasm" >&2
    echo "       run SKIP_BUILD=0 cargo build first" >&2
    exit 1
  fi
  echo "==> Deploying $name..."
  stellar contract deploy \
    --wasm "$wasm" \
    --source "$ADMIN_SECRET" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE"
}

EMT_CONTRACT_ID="$(deploy_contract emt_token)"
echo "EMT_CONTRACT_ID=$EMT_CONTRACT_ID"

HOOK_CONTRACT_ID="$(deploy_contract compliance_hook)"
echo "HOOK_CONTRACT_ID=$HOOK_CONTRACT_ID"

ORACLE_CONTRACT_ID="$(deploy_contract oracle_interface)"
echo "ORACLE_CONTRACT_ID=$ORACLE_CONTRACT_ID"

cat > "$DEPLOYMENT_FILE" <<EOF
{
  "network": "$NETWORK",
  "rpcUrl": "$RPC_URL",
  "networkPassphrase": "$NETWORK_PASSPHRASE",
  "contracts": {
    "emt_token": "$EMT_CONTRACT_ID",
    "compliance_hook": "$HOOK_CONTRACT_ID",
    "oracle_interface": "$ORACLE_CONTRACT_ID"
  }
}
EOF

echo ""
echo "==> Deployment complete. Picked up from $DEPLOYMENT_FILE:"
cat "$DEPLOYMENT_FILE"
echo ""
echo "Next: scripts/initialize.sh to assign roles."
