#!/usr/bin/env bash
#
# WebInspector agent onboarding (Linux, git-based).
#
# Self-contained onboarding that needs NO pre-published supervisor bundle: it installs Node,
# clones the repo, pins the ControlPlane CA, enrolls the node, and runs the supervisor as a
# systemd service. This is the path the Portal's Onboarding tab hands out for this deployment.
#
# Unattended one-liner (token via env):
#   export WEBINSPECTOR_CONTROLPLANE_URL='https://cp:8787'
#   export WEBINSPECTOR_ENROLLMENT_TOKEN='<token>'
#   export WEBINSPECTOR_NODE_TYPE='azure_direct'
#   curl -fsSLk "$WEBINSPECTOR_CONTROLPLANE_URL/bootstrap/install-agent.sh" | sudo -E bash
#
# (-k on the curl above tolerates the self-signed cert while downloading the installer; the
#  installer then PINS that same cert for the agent. Set WEBINSPECTOR_SKIP_BROWSER=1 to skip the
#  Chromium download.)
set -euo pipefail

CP="${WEBINSPECTOR_CONTROLPLANE_URL:-}"
TOKEN="${WEBINSPECTOR_ENROLLMENT_TOKEN:-}"
NODE_TYPE="${WEBINSPECTOR_NODE_TYPE:-}"
NODE_NAME="${WEBINSPECTOR_NODE_NAME:-$(hostname)}"
INSTALL_ROOT="${WEBINSPECTOR_INSTALL_ROOT:-/opt/webinspector}"
REPO="${WEBINSPECTOR_REPO:-https://github.com/jeevanbisht/WebInspector.git}"
BRANCH="${WEBINSPECTOR_BRANCH:-main}"
SERVICE="${WEBINSPECTOR_SERVICE:-webinspector-agent}"

log() { echo "[install-agent] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "install-agent must run as root (use: sudo -E bash)" >&2; exit 1; }
[ -n "$CP" ]        || { echo "WEBINSPECTOR_CONTROLPLANE_URL is required" >&2; exit 1; }
[ -n "$TOKEN" ]     || { echo "WEBINSPECTOR_ENROLLMENT_TOKEN is required" >&2; exit 1; }
[ -n "$NODE_TYPE" ] || { echo "WEBINSPECTOR_NODE_TYPE is required" >&2; exit 1; }
CP="${CP%/}"
export DEBIAN_FRONTEND=noninteractive

log "ensuring Node.js 18+ and git"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v git >/dev/null 2>&1 || apt-get install -y git

log "fetching code into $INSTALL_ROOT/app ($BRANCH)"
mkdir -p "$INSTALL_ROOT/tls"
if [ -d "$INSTALL_ROOT/app/.git" ]; then
  ( cd "$INSTALL_ROOT/app" && git fetch -q --all && git reset -q --hard "origin/$BRANCH" )
else
  git clone -q -b "$BRANCH" "$REPO" "$INSTALL_ROOT/app"
fi
( cd "$INSTALL_ROOT/app" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev )

# Pin the ControlPlane's certificate when it serves HTTPS, so the supervisor can trust wss.
CA_FILE=""
case "$CP" in
  https://*)
    log "pinning ControlPlane CA from $CP/bootstrap/ca.pem"
    if curl -fsSk "$CP/bootstrap/ca.pem" -o "$INSTALL_ROOT/tls/cp-ca.pem" && [ -s "$INSTALL_ROOT/tls/cp-ca.pem" ]; then
      CA_FILE="$INSTALL_ROOT/tls/cp-ca.pem"
    else
      log "WARN: could not fetch CA; relying on the system trust store"
    fi
    ;;
esac

log "preparing runtime layout"
mkdir -p "$INSTALL_ROOT/agent" "$INSTALL_ROOT/control-plane-agent"
ln -sfn "$INSTALL_ROOT/app/agent" "$INSTALL_ROOT/agent/current"
ln -sfn "$INSTALL_ROOT/app/control-plane-agent" "$INSTALL_ROOT/control-plane-agent/current"
echo "3.0.0" > "$INSTALL_ROOT/app/agent/VERSION"
echo "3.0.0" > "$INSTALL_ROOT/app/control-plane-agent/VERSION"

log "enrolling $NODE_NAME ($NODE_TYPE)"
cat > "$INSTALL_ROOT/onboard.mjs" <<'JS'
import os from "node:os";
const { enrollNode, persistIdentity } = await import(process.env.WI_ENROLL_MODULE);
const identity = { nodeName: process.env.WI_NAME, nodeType: process.env.WI_TYPE, platform: "linux", machineId: os.hostname(), os: `${os.type()} ${os.release()}` };
const enr = await enrollNode(process.env.WI_CP, process.env.WI_TOKEN, identity);
await persistIdentity(process.env.WI_ROOT, { ...identity, controlPlaneUrl: process.env.WI_CP, ...enr });
console.log("[install-agent] enrolled " + enr.nodeId);
JS
NODE_EXTRA_CA_CERTS="$CA_FILE" \
  WI_ENROLL_MODULE="file://$INSTALL_ROOT/app/bootstrap/enroll.mjs" \
  WI_CP="$CP" WI_ROOT="$INSTALL_ROOT" WI_NAME="$NODE_NAME" WI_TYPE="$NODE_TYPE" WI_TOKEN="$TOKEN" \
  node "$INSTALL_ROOT/onboard.mjs"

log "installing systemd service: $SERVICE"
{
  echo "[Unit]"
  echo "Description=WebInspector ControlPlane Agent (supervisor)"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo ""
  echo "[Service]"
  echo "Type=simple"
  echo "WorkingDirectory=$INSTALL_ROOT/app"
  echo "ExecStart=$(command -v node) control-plane-agent/core/index.mjs"
  echo "Environment=WEBINSPECTOR_INSTALL_ROOT=$INSTALL_ROOT"
  [ -n "$CA_FILE" ] && echo "Environment=NODE_EXTRA_CA_CERTS=$CA_FILE"
  echo "Environment=WEBINSPECTOR_SKIP_METADATA_LOOKUPS=1"
  echo "Restart=always"
  echo "RestartSec=5"
  echo "User=root"
  echo ""
  echo "[Install]"
  echo "WantedBy=multi-user.target"
} > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 4
log "service $SERVICE: $(systemctl is-active "$SERVICE")"

if [ "${WEBINSPECTOR_SKIP_BROWSER:-0}" != "1" ]; then
  log "installing Chromium for browser validation (set WEBINSPECTOR_SKIP_BROWSER=1 to skip)"
  ( cd "$INSTALL_ROOT/app" && npx --yes playwright install --with-deps chromium >/dev/null 2>&1 && log "chromium ready" ) || log "WARN: chromium install failed; browser validation will be unavailable until installed"
fi

log "done — the ControlPlane will show this node once its heartbeat lands."
