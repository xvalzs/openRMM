#!/usr/bin/env bash
# OpenRMM VPS setup — run as root on a fresh Ubuntu 22.04/24.04 server:
#   curl -fsSL https://raw.githubusercontent.com/xvalzs/openRMM/main/deploy/vps/setup.sh | bash
#
# Installs Docker (if missing), deploys the OpenRMM server with a
# persistent data volume, generates credentials, and prints the URLs.
set -euo pipefail

echo "==> OpenRMM VPS setup"

# ---- 1. Install Docker if needed ---------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

# ---- 2. Prepare /opt/openrmm ---------------------------------------------
mkdir -p /opt/openrmm/data
cd /opt/openrmm

IMAGE="ghcr.io/xvalzs/openrmm:latest"
PULL_OK=0
if docker pull "$IMAGE" >/dev/null 2>&1; then
  echo "==> Using published image $IMAGE"
  PULL_OK=1
else
  echo "==> Image not publicly pullable (package may be private) — building from source"
  apt-get install -y -qq git
  if [ ! -d /opt/openrmm/src ]; then
    git clone https://github.com/xvalzs/openRMM.git /opt/openrmm/src
  fi
fi

# ---- 3. Credentials -------------------------------------------------------
ADMIN_PASSWORD="$(openssl rand -hex 12)"
SESSION_SECRET="$(openssl rand -hex 32)"
INSTALL_KEY="$(openssl rand -hex 32)"
PUBLIC_URL="${RMM_PUBLIC_URL:-http://$(hostname -I | awk '{print $1}'):8787}"

cat > /opt/openrmm/.env <<EOF
RMM_ADMIN_PASSWORD=$ADMIN_PASSWORD
RMM_SESSION_SECRET=$SESSION_SECRET
RMM_INSTALL_KEY=$INSTALL_KEY
RMM_PUBLIC_URL=$PUBLIC_URL
EOF
chmod 600 /opt/openrmm/.env

# ---- 4. Run -----------------------------------------------------------------
if [ "$PULL_OK" = "1" ]; then
  docker rm -f openrmm >/dev/null 2>&1 || true
  docker run -d --name openrmm \
    --restart unless-stopped \
    -p 8787:8787 \
    -v /opt/openrmm/data:/app/data \
    --env-file /opt/openrmm/.env \
    "$IMAGE"
else
  cd /opt/openrmm/src
  docker compose -f - up -d --build <<'COMPOSE'
services:
  openrmm:
    build: .
    restart: unless-stopped
    ports: ["8787:8787"]
    volumes: ["/opt/openrmm/data:/app/data"]
    env_file: "/opt/openrmm/.env"
COMPOSE
fi

# ---- 5. Report ----------------------------------------------------------------
IP="$(hostname -I | awk '{print $1}')"
echo ""
echo "=============================================="
echo " OpenRMM is running"
echo "=============================================="
echo "  Dashboard:   http://$IP:8787"
echo "  Username:    admin"
echo "  Password:    $ADMIN_PASSWORD"
echo "  Install key: $INSTALL_KEY"
echo ""
echo "  Credentials are stored in /opt/openrmm/.env"
echo "  Data (SQLite + uploads): /opt/openrmm/data"
echo ""
echo "  Next steps for a permanent HTTPS URL:"
echo "    1. Add a domain to Cloudflare and point rmm.<domain>"
echo "       (DNS A record → $IP, proxy on) — or run a Cloudflare"
echo "       Tunnel: deploy/cloudflared/README.md"
echo "    2. Set RMM_PUBLIC_URL=https://rmm.<domain> in /opt/openrmm/.env"
echo "       and restart: docker restart openrmm"
echo "=============================================="
