#!/usr/bin/env bash
# degent.club server bootstrap (docs/SERVER.md). Idempotent and non-interactive: the deploy workflow copies this file
# and deploy.sh to the server and runs `sudo bash bootstrap.sh` before every deploy. It keeps existing secrets and
# settings. By hand (optional): download, read, run:
#
#   curl -fsSLo bootstrap.sh https://raw.githubusercontent.com/DegentClub/degent/claude/magical-einstein-ugdy2r/products/degent/deploy/server/bootstrap.sh
#   less bootstrap.sh && sudo bash bootstrap.sh
#
# What it does: apt upgrade + unattended-upgrades; Docker Engine + compose plugin (Docker's apt repository); ufw
# (22, 80, 443/tcp, 443/udp; deny other incoming); fail2ban for sshd (5 failures in 10 min -> 1 h ban); sshd:
# PermitRootLogin no, MaxAuthTries 3 (password logins are left as they are: the workflow logs in with the password);
# a system user `deploy` (no login, no sudo) that owns the app secrets and data; /opt/degent/{bin,secrets,data,
# compose,state,releases}; per-network app secrets (reveal-encryption-key, session-key; 32 random bytes, hex, mode
# 600, owner deploy); /opt/degent/compose/.env (non-secret settings, MINT_MODE readonly on both networks); a summary.
# Degents are parentless (ADR-0010): no parent key, signer key or KMS credential is created here.
#
# It never asks for, stores or prints a password.
# Optional: WITH_DEPLOY_KEY=1 installs the hardened path (a key-only SSH key for `deploy`, forced command
# /opt/degent/bin/deploy.sh, private half printed once); run it by hand, never from CI (it would land in the log).
set -euo pipefail

DEGENT_REPO="${DEGENT_REPO:-DegentClub/degent}"
DEGENT_REF="${DEGENT_REF:-claude/magical-einstein-ugdy2r}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/${DEGENT_REPO}/${DEGENT_REF}/products/degent/deploy/server}"
DEGENT_HOME="${DEGENT_HOME:-/opt/degent}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
OWNER_USER="${OWNER_USER:-ubuntu}"
DEPLOY_HOST="${DEPLOY_HOST:-170.75.173.105}"
PUBLIC_IPV6="${PUBLIC_IPV6:-2602:ffb6:4:7685:f816:3eff:fef0:f465}"
SITE_DOMAIN="${SITE_DOMAIN:-degent.club}"
MINT_DOMAIN="${MINT_DOMAIN:-mint.degent.club}"
SIGNET_DOMAIN="${SIGNET_DOMAIN:-signet.degent.club}"
WITH_DEPLOY_KEY="${WITH_DEPLOY_KEY:-0}"
KEY_MARKER="degent-github-actions-deploy"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo bash bootstrap.sh" >&2; exit 1; }
# shellcheck disable=SC1091 # present on every Ubuntu
. /etc/os-release
[ "${ID:-}" = ubuntu ] || warn "written for Ubuntu 22.04; this is ${PRETTY_NAME:-unknown}"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
# deploy.sh next to this file when it was copied or downloaded as a file; fetched from RAW_BASE when piped into bash.
SCRIPT_DIR=/nonexistent
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi

# ------------------------------------------------------------------------------------------------ packages
say "apt update / upgrade"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef upgrade
apt-get -y -q -o Dpkg::Options::=--force-confold install ca-certificates curl gnupg jq openssl ufw fail2ban python3-systemd unattended-upgrades

say "unattended-upgrades (security updates daily, no automatic reboot)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null

say "Docker Engine + compose plugin (download.docker.com)"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
EOF
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# ------------------------------------------------------------------------------------------------ firewall
say "ufw: allow 22/tcp, 80/tcp, 443/tcp, 443/udp; deny other incoming"
ufw allow 22/tcp >/dev/null      # first, so enabling the firewall never cuts this session
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
# Docker publishes container ports through its own iptables chains; compose.server.yaml publishes only 80 and 443.

say "fail2ban: sshd jail (5 failures in 10 minutes -> banned for 1 hour)"
cat > /etc/fail2ban/jail.d/degent-sshd.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban >/dev/null
systemctl restart fail2ban

say "sshd: PermitRootLogin no, MaxAuthTries 3 (password logins unchanged)"
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-degent.conf
cat > "$SSHD_DROPIN.tmp" <<'EOF'
# degent.club bootstrap.sh (docs/SERVER.md). Earlier files win in sshd_config.d, hence 10-.
# PasswordAuthentication is deliberately not set here: the deploy workflow logs in as ubuntu with its password.
PermitRootLogin no
MaxAuthTries 3
X11Forwarding no
EOF
mv "$SSHD_DROPIN.tmp" "$SSHD_DROPIN"
chmod 644 "$SSHD_DROPIN"
if sshd -t; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
else
  rm -f "$SSHD_DROPIN"
  warn "sshd rejected the hardening drop-in; removed it, sshd unchanged"
fi

# ------------------------------------------------------------------------------------------------ users + layout
say "user ${DEPLOY_USER}: owns the app secrets and data; no password, no sudo"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "degent deploy" "$DEPLOY_USER" >/dev/null
fi
usermod -p '*' "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
gpasswd -d "$DEPLOY_USER" sudo >/dev/null 2>&1 || true
rm -f "/etc/sudoers.d/$DEPLOY_USER"
DEPLOY_UID="$(id -u "$DEPLOY_USER")"
DEPLOY_GID="$(id -g "$DEPLOY_USER")"
DEPLOY_HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"

say "layout ${DEGENT_HOME}"
install -d -m 0755 -o root -g root "$DEGENT_HOME" "$DEGENT_HOME/bin"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEGENT_HOME/secrets" "$DEGENT_HOME/secrets/mainnet" "$DEGENT_HOME/secrets/signet"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEGENT_HOME/compose" "$DEGENT_HOME/data" \
  "$DEGENT_HOME/data/mainnet-mint" "$DEGENT_HOME/data/signet-mint" "$DEGENT_HOME/backups"
install -d -m 0700 -o root -g root "$DEGENT_HOME/state" "$DEGENT_HOME/releases"

say "deploy.sh -> ${DEGENT_HOME}/bin/deploy.sh (root-owned)"
if [ -f "$SCRIPT_DIR/deploy.sh" ]; then
  bash -n "$SCRIPT_DIR/deploy.sh"
  install -m 0755 -o root -g root "$SCRIPT_DIR/deploy.sh" "$DEGENT_HOME/bin/deploy.sh"
elif [ ! -f "$DEGENT_HOME/bin/deploy.sh" ]; then
  tmp_deploy="$(mktemp)"
  curl -fsSL "$RAW_BASE/deploy.sh" -o "$tmp_deploy"
  bash -n "$tmp_deploy"
  install -m 0755 -o root -g root "$tmp_deploy" "$DEGENT_HOME/bin/deploy.sh"
  rm -f "$tmp_deploy"
fi

# ------------------------------------------------------------------------------------------------ secrets
say "app secrets (${DEGENT_HOME}/secrets/<network>/, mode 600, owner ${DEPLOY_USER}; existing ones kept)"
new_secret() { # new_secret <network> <name>: 32 random bytes as hex, only if the file does not exist yet
  local f="$DEGENT_HOME/secrets/$1/$2"
  if [ ! -s "$f" ]; then
    (umask 077; openssl rand -hex 32 > "$f.tmp")
    mv "$f.tmp" "$f"
  fi
  chown "$DEPLOY_USER:$DEPLOY_USER" "$f"
  chmod 600 "$f"
}
for net in mainnet signet; do
  new_secret "$net" reveal-encryption-key
  new_secret "$net" session-key
done

say "settings ${DEGENT_HOME}/compose/.env (non-secret; existing values are kept)"
ENV_FILE="$DEGENT_HOME/compose/.env"
touch "$ENV_FILE"
env_default() { # env_default KEY VALUE: add KEY=VALUE unless KEY is already set
  grep -qE "^$1=" "$ENV_FILE" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}
env_force() { # env_force KEY VALUE: facts about this machine, always refreshed
  { grep -vE "^$1=" "$ENV_FILE" || true; printf '%s=%s\n' "$1" "$2"; } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}
env_force DEGENT_HOME "$DEGENT_HOME"
env_force DEPLOY_UID "$DEPLOY_UID"
env_force DEPLOY_GID "$DEPLOY_GID"
env_default SITE_DOMAIN "$SITE_DOMAIN"
env_default MINT_DOMAIN "$MINT_DOMAIN"
env_default SIGNET_DOMAIN "$SIGNET_DOMAIN"
env_default APEX_REDIRECT true
env_default WWW_REDIRECT false
# Read-only until the parentless mint (ADR-0010) has merged; then set full here and deploy again (docs/SERVER.md).
env_default MAINNET_MINT_MODE readonly
env_default SIGNET_MINT_MODE readonly
chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ------------------------------------------------------------------------------------------------ optional hardened path
if [ "$WITH_DEPLOY_KEY" = 1 ]; then
  say "deploy SSH key (forced command; private half printed ONCE, then deleted)"
  AUTH="$DEPLOY_HOME_DIR/.ssh/authorized_keys"
  install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME_DIR/.ssh"
  keydir="$(mktemp -d /root/degent-deploy-key.XXXXXX)"
  ssh-keygen -q -t ed25519 -N "" -C "$KEY_MARKER" -f "$keydir/id_ed25519"
  printf 'command="%s/bin/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc %s\n' \
    "$DEGENT_HOME" "$(cat "$keydir/id_ed25519.pub")" > "$AUTH"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"
  chmod 600 "$AUTH"
  echo "GitHub secret DEPLOY_SSH_KEY (copy between the lines):"
  echo "-----8<-----"
  cat "$keydir/id_ed25519"
  echo "-----8<-----"
  shred -u "$keydir/id_ed25519" 2>/dev/null || rm -f "$keydir/id_ed25519"
  rm -rf "$keydir"
  echo "Note: the deploy user needs sudo-free access to deploy.sh state for this path; see docs/SERVER.md (hardened option)."
fi

# ------------------------------------------------------------------------------------------------ summary
say "server"
echo "cpus: $(nproc)"
free -h
df -h /
echo "host key: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)"

say "DNS records (at the DNS provider)"
echo "  A  ${SITE_DOMAIN}    -> ${DEPLOY_HOST}   (301 to https://${MINT_DOMAIN})"
echo "  A  ${MINT_DOMAIN}    -> ${DEPLOY_HOST}   (the app, mainnet, read-only until minting opens)"
echo "  A  ${SIGNET_DOMAIN}  -> ${DEPLOY_HOST}   (signet beta)"
echo "  optional AAAA for the same three names -> ${PUBLIC_IPV6}"

say "security reminder"
echo "  ${OWNER_USER} logs in with a password that was shared in plain text. Change it with 'passwd' (then update the"
echo "  SERVER_PASSWORD secret) and add an SSH key: ssh-copy-id ${OWNER_USER}@${DEPLOY_HOST}. Root login is off,"
echo "  3 tries per connection, fail2ban bans 5 failures in 10 minutes for 1 hour."
echo "bootstrap: ok"
