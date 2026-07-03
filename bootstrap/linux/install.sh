#!/usr/bin/env bash
#
# WebInspector zero-touch node bootstrap (Linux).
#
# Tiny installer an admin — or automation (Azure VM Custom Script Extension, cloud-init) — runs
# on a fresh VM to onboard it into the WebInspector control plane. It ensures Node.js is present,
# downloads the cross-platform bootstrap orchestrator, and runs it. The orchestrator installs the
# ControlPlane Agent as a systemd service and enrolls the node; the control plane then converges
# it to desired state with no further steps.
#
# Unattended one-liner (token via env):
#   export WEBINSPECTOR_CONTROLPLANE_URL='http://cp:8787'
#   export WEBINSPECTOR_ENROLLMENT_TOKEN='<token>'
#   export WEBINSPECTOR_NODE_TYPE='azure_direct'
#   curl -fsSL "$WEBINSPECTOR_CONTROLPLANE_URL/bootstrap/install.sh" | sudo -E bash

set -euo pipefail

CP="${WEBINSPECTOR_CONTROLPLANE_URL:-}"
TOKEN="${WEBINSPECTOR_ENROLLMENT_TOKEN:-}"
NODE_TYPE="${WEBINSPECTOR_NODE_TYPE:-}"
NODE_NAME="${WEBINSPECTOR_NODE_NAME:-$(hostname)}"
INSTALL_ROOT="${WEBINSPECTOR_INSTALL_ROOT:-/opt/webinspector}"

log() { echo "[bootstrap] $*"; }

# 1. Require root (needed to install a systemd service).
if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root (use sudo)." >&2
  exit 1
fi

# 2. Validate required inputs.
[ -n "$CP" ]        || { echo "WEBINSPECTOR_CONTROLPLANE_URL is required." >&2; exit 1; }
[ -n "$TOKEN" ]     || { echo "WEBINSPECTOR_ENROLLMENT_TOKEN is required." >&2; exit 1; }
[ -n "$NODE_TYPE" ] || { echo "WEBINSPECTOR_NODE_TYPE is required." >&2; exit 1; }
CP="${CP%/}"

# 3. Ensure the Node.js runtime.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 18+ (or provision a pinned runtime)." >&2
  exit 1
fi

# 4. Download the tiny cross-platform bootstrap orchestrator.
BOOT_DIR="$INSTALL_ROOT/bootstrap"
mkdir -p "$BOOT_DIR"
log "downloading bootstrap from $CP/bootstrap/bootstrap.mjs"
curl -fsSL "$CP/bootstrap/bootstrap.mjs" -o "$BOOT_DIR/bootstrap.mjs"

# 5. Run it — verifies + installs the supervisor (systemd), enrolls the node, starts the service.
log "onboarding $NODE_NAME ($NODE_TYPE)"
node "$BOOT_DIR/bootstrap.mjs" \
  --url "$CP" \
  --token "$TOKEN" \
  --node-name "$NODE_NAME" \
  --node-type "$NODE_TYPE" \
  --install-root "$INSTALL_ROOT"

log "done — node is enrolled; the control plane will finish onboarding automatically."
