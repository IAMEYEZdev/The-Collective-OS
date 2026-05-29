#!/usr/bin/env bash
# scripts/claw-code-build.sh
# Compile claw-code from fork into usable binary
set -euo pipefail

PROJECT_ROOT="${CLAUDECLAW_PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLAW_SRC="${PROJECT_ROOT}/forks/claw-code-collective/rust"
CLAW_BIN_DIR="${PROJECT_ROOT}/bin"

echo "[claw-code-build] Source: ${CLAW_SRC}"
echo "[claw-code-build] Target: ${CLAW_BIN_DIR}"

# Verify Rust toolchain
if ! command -v cargo &>/dev/null; then
  echo "ERROR: cargo not found. Install Rust: https://rustup.rs"
  exit 1
fi

echo "[claw-code-build] Rust: $(rustc --version)"
echo "[claw-code-build] Cargo: $(cargo --version)"

# Build release binary
cd "${CLAW_SRC}"
echo "[claw-code-build] Building release binary..."
cargo build --release --bin claw 2>&1

# Copy binary
mkdir -p "${CLAW_BIN_DIR}"
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
  cp target/release/claw.exe "${CLAW_BIN_DIR}/claw.exe"
  echo "[claw-code-build] Binary: ${CLAW_BIN_DIR}/claw.exe"
else
  cp target/release/claw "${CLAW_BIN_DIR}/claw"
  chmod +x "${CLAW_BIN_DIR}/claw"
  echo "[claw-code-build] Binary: ${CLAW_BIN_DIR}/claw"
fi

# Verify
"${CLAW_BIN_DIR}/claw" --version || "${CLAW_BIN_DIR}/claw.exe" --version
echo "[claw-code-build] Done."
