#!/bin/sh
# ---------------------------------------------------------------------------
#  PasarGuard / VPN panel  -  one-shot setup for a NEW server
#
#  usage:  bash setup.sh <NEW_IP> <NEW_PORT>
#  example: bash setup.sh 45.12.34.56 20275
#
#  It only patches this kit for the new address and makes sure the runtime
#  pieces (venv, python deps, folders) exist.  It never touches the users.
# ---------------------------------------------------------------------------
set -eu

IP="${1:-}"
PORT="${2:-}"
ROOT="${KB_ROOT:-/home/container}"
PG="$ROOT/pasarguard-native"
IDX="$ROOT/index.js"

if [ -z "$IP" ] || [ -z "$PORT" ]; then
  echo "usage: bash setup.sh <NEW_IP> <NEW_PORT>"
  exit 1
fi
case "$IP" in *[!0-9.]*) echo "IP must be a plain IPv4 address"; exit 1;; esac
case "$PORT" in *[!0-9]*) echo "PORT must be a number"; exit 1;; esac

echo "== 1/9 files =="
for f in "$IDX" "$PG/app/app_factory.py" "$PG/run-native.sh.real" "$ROOT/requirements-freeze.txt"; do
  [ -e "$f" ] || { echo "MISSING: $f  (extract kb-panel-export.tgz into /home/container first)"; exit 1; }
done

mkdir -p "$ROOT/.tmp"
echo "== 2/9 patch index.js -> $IP:$PORT =="
cp "$IDX" "$ROOT/.tmp/index.js.bak-$(date +%H%M%S)" 2>/dev/null || true
if grep -q "51.68.234.157" "$IDX"; then
  sed -i "s/51\.68\.234\.157/$IP/g" "$IDX"
fi
if grep -q "20275" "$IDX"; then
  sed -i "s/20275/$PORT/g" "$IDX"
fi
NODE_BIN="$ROOT/.runtime/node/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then
  if "$NODE_BIN" --check "$IDX"; then echo "   node syntax OK"; else echo "   !! index.js syntax error"; exit 1; fi
fi

echo "== 3/9 fresh server identity =="
# state.json holds the old server's id/marks; deleting it lets index.js mint a
# new identity for THIS machine.  Login is pinned to GUCCi/GUCCi either way.
rm -f "$ROOT/vpn/state.json"

echo "== 4/9 folders =="
mkdir -p "$ROOT/vpn/bin" "$ROOT/vpn/log" "$ROOT/vpn/mtp" "$ROOT/vpn/data/backups" \
         "$PG/data" "$PG/backups" "$ROOT/.tmp"
touch "$ROOT/.enable-pasarguard-native"
chmod +x "$PG/run-native.sh" "$PG/run-native.sh.real" 2>/dev/null || true

echo "== 5/9 python venv =="
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  PYBIN="$(command -v python3.14 || command -v python3)"
  echo "   creating venv with $PYBIN"
  "$PYBIN" -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/python" -V

echo "== 6/9 python packages =="
if [ ! -d "$PG/pylibs/sqlalchemy" ]; then
  echo "   installing $(wc -l < "$ROOT/requirements-freeze.txt") pinned packages (takes a few minutes)"
  "$ROOT/.venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check \
      --target "$PG/pylibs" -r "$ROOT/requirements-freeze.txt" > "$ROOT/.tmp/pip.log" 2>&1 \
      || { echo "   pip failed, see /home/container/.tmp/pip.log"; tail -5 "$ROOT/.tmp/pip.log"; exit 1; }
else
  echo "   pylibs already present"
fi

echo "== 7/9 databases -> $IP:$PORT =="
if [ -f "$ROOT/patch-db.py" ]; then
  "$ROOT/.venv/bin/python" "$ROOT/patch-db.py" "$IP" "$PORT" || echo "   (db patch skipped)"
fi

echo "== 8/9 openvpn config =="
if [ -f "$ROOT/vpn/openvpn/server.conf" ]; then
  grep -q "51.68.234.157" "$ROOT/vpn/openvpn/server.conf" 2>/dev/null && \
    sed -i "s/51\.68\.234\.157/$IP/g" "$ROOT/vpn/openvpn/server.conf" || true
  echo "   ok"
fi

echo "== 9/9 done =="
cat <<TXT

  setup finished for $IP:$PORT

  now restart the server from the panel (or console):
      exit        # index.js is restarted by the host

  first boot does this by itself (5-15 min, watch the console):
    - downloads the VPN-UI binary (346 MB) and unpacks Xray + telemt
    - creates the 10 inbounds exactly like the original
    - writes OpenVPN keys/certs, WireGuard + AmneziaWG + Hysteria2 + MTProto
    - seeds PasarGuard and rebuilds the dashboard

  login:      GUCCi / GUCCi       (fixed - it will not rotate)
  panel:      http://$IP:$PORT/TeamGuccI/pasarguard/
  sub:        http://$IP:$PORT/sub/<each user's id>

TXT
