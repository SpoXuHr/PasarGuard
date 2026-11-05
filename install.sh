#!/usr/bin/env bash
# Prepare a persistent Docker installation. Existing users, password and volume
# are never reset. An explicit --http/--https changes only the access scheme.
set -Eeuo pipefail
cd -- "$(dirname -- "$0")"
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
mode=''
case "${1:-}" in
  '') ;;
  --http) mode=http ;;
  --https) mode=https ;;
  --help|-h)
    printf 'Usage: sudo ./install.sh [--http|--https]\n'
    printf 'Default for a new installation: HTTPS (self-signed). --http uses unencrypted HTTP.\n'
    exit 0 ;;
  *) fail 'Usage: sudo ./install.sh [--http|--https]' ;;
esac
(($# <= 1)) || fail 'Specify at most one mode.'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'This release requires Linux x86_64 (amd64).'
command -v docker >/dev/null || fail 'Install Docker Engine and the Docker Compose plugin first.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 plugin is required (docker compose).'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable or the current user cannot access it.'
command -v curl >/dev/null || fail 'Install curl first.'
# Compose normally prioritizes the calling shell over .env. Keep those values
# sourced from the local .env so the selected mode and readiness check agree.
unset ADMIN_PASSWORD SERVER_IP PANEL_HOST VPN_PORT PUBLIC_TLS SUB_SCHEME

if [[ ! -f .env ]]; then
  port=${PASARGUARD_PORT:-20004}
  [[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || fail 'PASARGUARD_PORT must be between 1 and 65535.'
  port=$((10#$port))
  host=${PASARGUARD_HOST:-}
  if [[ -z $host ]]; then
    host=$(curl --noproxy '*' -4fsS --connect-timeout 4 --max-time 8 https://api.ipify.org 2>/dev/null || true)
    [[ -n $host ]] || host=$(curl --noproxy '*' -4fsS --connect-timeout 4 --max-time 8 https://icanhazip.com 2>/dev/null || true)
  fi
  [[ -n $host && ${#host} -le 253 && $host =~ ^[A-Za-z0-9.-]+$ && $host != .* && $host != *..* && $host != *. ]] || fail 'Could not detect a safe public host. Retry with PASARGUARD_HOST=<public-IP-or-domain> ./install.sh'
  password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  [[ ${#password} == 48 ]] || fail 'Could not generate the administrator password.'
  scheme=${mode:-https}
  tls=1; [[ $scheme == http ]] && tls=0
  if ! (set -C; printf 'SERVER_IP=%s\nVPN_PORT=%s\nADMIN_PASSWORD=%s\nSUB_SCHEME=%s\nPUBLIC_TLS=%s\n' "$host" "$port" "$password" "$scheme" "$tls" > .env); then
    fail 'Could not create .env safely; existing files were not overwritten.'
  fi
  chmod 600 .env
  unset password
  printf 'Created a private .env file and a new administrator password.\n'
else
  [[ -f .env && ! -L .env ]] || fail 'Refusing to use a non-regular or symlinked .env file.'
  chmod 600 .env
  printf 'Existing .env found; credentials and stored data will be preserved.\n'
  if [[ -n $mode ]]; then
    scheme=$mode
    tls=1; [[ $scheme == http ]] && tls=0
    tmp=$(mktemp .env.XXXXXXXX)
    trap 'rm -f -- "${tmp:-}"' EXIT
    awk '!/^(SUB_SCHEME|PUBLIC_TLS)=/' .env > "$tmp"
    printf 'SUB_SCHEME=%s\nPUBLIC_TLS=%s\n' "$scheme" "$tls" >> "$tmp"
    chmod 600 "$tmp"
    mv -f -- "$tmp" .env
    tmp=''
    printf 'Access mode set to %s; the service will be recreated without removing its volume.\n' "$scheme"
  fi
fi

host=$(sed -n 's/^SERVER_IP=//p' .env | tail -n 1)
port=$(sed -n 's/^VPN_PORT=//p' .env | tail -n 1)
scheme=$(sed -n 's/^SUB_SCHEME=//p' .env | tail -n 1); scheme=${scheme:-https}
tls=$(sed -n 's/^PUBLIC_TLS=//p' .env | tail -n 1); tls=${tls:-1}
[[ $scheme == https && $tls == 1 || $scheme == http && $tls == 0 ]] || fail 'Invalid .env: SUB_SCHEME and PUBLIC_TLS must be https/1 or http/0.'
[[ -n $host && $host =~ ^[A-Za-z0-9.-]+$ && $port =~ ^[0-9]{1,5}$ ]] || fail 'Invalid host/port in .env; no container was started.'
if [[ $scheme == http ]]; then
  printf 'WARNING: HTTP is unencrypted. Passwords, sessions and subscription links can be intercepted or modified. Use only on a trusted network or behind a properly configured HTTPS proxy.\n' >&2
fi

docker compose config --quiet || fail 'Invalid compose configuration; inspect .env without sharing its password.'
docker compose up -d --build || fail 'Build/start failed. Existing persistent data was not removed.'
printf 'Waiting up to 3 minutes for the dashboard API...\n'
ready=0
for ((i=0; i<90; i++)); do
  status=$(curl --noproxy '*' --resolve "$host:$port:127.0.0.1" -k -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 "$scheme://$host:$port/TeamGuccI/pg/api/users" || true)
  # An unauthenticated 401 means the native API, not just the static SPA, is up.
  if [[ $status == 401 || $status == 403 ]]; then ready=1; break; fi
  sleep 2
done
if ((ready == 0)); then
  printf 'Dashboard was not ready in time. Inspect: docker compose logs --tail=100\n' >&2
  exit 1
fi
printf '\nPanel: %s://%s:%s/TeamGuccI/\n' "$scheme" "$host" "$port"
printf 'Dashboard: %s://%s:%s/TeamGuccI/pasarguard/\n' "$scheme" "$host" "$port"
printf 'Username: GUCCi\nPassword: stored in .env (ADMIN_PASSWORD); keep it private.\n'
if [[ $scheme == https ]]; then
  printf 'The default certificate is self-signed. Verify its fingerprint securely or configure trusted TLS before using it over an untrusted network.\n'
else
  printf 'HTTP is unencrypted; do not send credentials over untrusted networks.\n'
fi
printf 'Open TCP %s and, if needed, UDP %s in the host and provider firewalls.\n' "$port" "$port"
