#!/usr/bin/env bash
# Prepare one fresh, persistent Docker installation. Existing .env and volume
# are never reset or overwritten. Run from a trusted checkout of this repo.
set -Eeuo pipefail
cd -- "$(dirname -- "$0")"
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'This release requires Linux x86_64 (amd64).'
command -v docker >/dev/null || fail 'Install Docker Engine and the Docker Compose plugin first.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 plugin is required (docker compose).'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable or the current user cannot access it.'
command -v curl >/dev/null || fail 'Install curl first.'

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
  # Hex uses only Docker dotenv-safe characters. No GitHub token is stored.
  password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  [[ ${#password} == 48 ]] || fail 'Could not generate the administrator password.'
  if ! (set -C; printf 'SERVER_IP=%s\nVPN_PORT=%s\nADMIN_PASSWORD=%s\n' "$host" "$port" "$password" > .env); then
    fail 'Could not create .env safely; existing files were not overwritten.'
  fi
  chmod 600 .env
  unset password
  printf 'Created a private .env file and a new administrator password.\n'
else
  [[ -f .env && ! -L .env ]] || fail 'Refusing to use a non-regular or symlinked .env file.'
  chmod 600 .env
  printf 'Existing .env found; credentials and stored data will be preserved.\n'
fi

docker compose config --quiet || fail 'Invalid compose configuration; inspect .env without sharing its password.'
docker compose up -d --build || fail 'Build/start failed. Existing persistent data was not removed.'
# .env was either created above or provided by the operator; parse only simple
# host/port values for the local readiness check, never execute it as shell code.
host=$(sed -n 's/^SERVER_IP=//p' .env | tail -n 1)
port=$(sed -n 's/^VPN_PORT=//p' .env | tail -n 1)
if [[ -z $host || -z $port || ! $host =~ ^[A-Za-z0-9.-]+$ || ! $port =~ ^[0-9]{1,5}$ ]]; then
  printf 'Service started. Custom .env format: check status with docker compose logs -f.\n'
  exit 0
fi
printf 'Waiting up to 3 minutes for the dashboard...\n'
ready=0
for ((i=0; i<90; i++)); do
  status=$(curl --noproxy '*' --resolve "$host:$port:127.0.0.1" -k -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 "https://$host:$port/TeamGuccI/pg/api/users" || true)
  # An unauthenticated 401 means the native API, not just the static SPA, is up.
  if [[ $status == 401 || $status == 403 ]]; then ready=1; break; fi
  sleep 2
done
if ((ready == 0)); then
  printf 'Dashboard was not ready in time. Inspect: docker compose logs --tail=100\n' >&2
  exit 1
fi
printf '\nDashboard: https://%s:%s/TeamGuccI/pasarguard/\n' "$host" "$port"
printf 'Username: GUCCi\nPassword: stored in .env (ADMIN_PASSWORD); keep it private.\n'
printf 'The default certificate is self-signed. Verify its fingerprint securely or configure trusted TLS before using it over an untrusted network.\n'
printf 'Open TCP %s and, if needed, UDP %s in the host and provider firewalls.\n' "$port" "$port"
