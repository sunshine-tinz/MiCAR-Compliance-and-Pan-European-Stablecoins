#!/usr/bin/env bash
# verify.sh — Run CI's local checks in one command.
#
# Mirrors `.github/workflows/ci.yml` exactly, minus the caches and the
# docs-sanity job (which is a tiny `test -f` loop best kept in CI).
# Stops on first failure.
#
# Usage:
#   ./scripts/verify.sh
#
# What it runs:
#   1. `cargo fmt --all -- --check`           (contracts)
#   2. `cargo clippy --all-targets --all-features -- -D warnings`  (contracts)
#   3. `cargo test --all`                     (contracts)
#   4. `(npm ci || npm install)`             (sdk) — first-time-contributor robustness.
#      Tries `npm ci` first (fast + lockfile-pinned); on any failure (no
#      lockfile, lockfile drift, network blip, peer-dep conflict on a
#      populated `node_modules`, …) falls back to `npm install`.
#      Note: this is *broader* than CI's
#      `if [ -f package-lock.json ]; then npm ci; else npm install; fi`
#      — CI only falls back on a missing lockfile; the `||` form here
#      silently catches every `npm ci` failure. Acceptable trade-off for
#      first-time-contributor safety, but worth knowing if you ever see
#      a `npm ci` regression mask locally.
#   5. `npm run build`                        (sdk)
#   6. `npm test`                             (sdk)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
SDK_DIR="$PROJECT_ROOT/sdk"

run_step() {
  local title="$1"; shift
  echo ""
  echo "==> $title"
  echo "    + $*" >&2  # echo the command being run, on stderr so it doesn't get swallowed
  "$@"
}

run_step "Validate Rust formatting" \
  bash -c "cd '$CONTRACTS_DIR' && cargo fmt --all -- --check"

run_step "Lint Rust (clippy)" \
  bash -c "cd '$CONTRACTS_DIR' && cargo clippy --all-targets --all-features -- -D warnings"

run_step "Run Rust tests" \
  bash -c "cd '$CONTRACTS_DIR' && cargo test --all"

run_step "Install SDK dependencies (npm ci || npm install)" \
  # Runtime grouping: `cd '...' && (npm ci || npm install)` makes the
  # ordering explicit. Note: this *narrows slightly* vs the previous
  # implicit `(cd && npm ci) || npm install` — if `cd` itself fails,
  # `npm install` is NOT run (so we never accidentally install in the
  # wrong cwd). Safer when SDK_DIR is well-known; the previous lenient
  # form would have tried `npm install` from wherever we happened to be.
  bash -c "cd '$SDK_DIR' && (npm ci || npm install)"

run_step "Build SDK" \
  bash -c "cd '$SDK_DIR' && npm run build"

run_step "Run SDK tests" \
  bash -c "cd '$SDK_DIR' && npm test"

echo ""
echo "==> verify.sh: ALL CHECKS PASSED"
