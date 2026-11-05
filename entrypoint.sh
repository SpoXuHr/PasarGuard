#!/bin/sh
set -eu
cd /home/container
: "${ADMIN_PASSWORD:?missing admin password}"
[ "${RAILWAY_VOLUME_MOUNT_PATH:-}" = "/persistent" ] || { echo 'Persistent volume not mounted; refusing to start'; exit 1; }
mkdir -p /persistent/vpn-data /persistent/openvpn /persistent/native-data /home/container/vpn /home/container/pasarguard-native
# VPN-UI initializes a new empty database on first start.
if [ ! -f /persistent/native-data/pasarguard.db ]; then cp /home/container/native-fresh.db /persistent/native-data/pasarguard.db; fi
rm -rf /home/container/vpn/data /home/container/vpn/openvpn /home/container/pasarguard-native/data
ln -s /persistent/vpn-data /home/container/vpn/data
ln -s /persistent/openvpn /home/container/vpn/openvpn
ln -s /persistent/native-data /home/container/pasarguard-native/data
# Keep OpenVPN traffic on the Amsterdam service's direct egress.
# WARP may otherwise add a second geographic hop and additional MTU limits.
if [ ! -e /persistent/vpn-data/warp-route.json ]; then echo '{"openvpn":false}' > /persistent/vpn-data/warp-route.json; fi
if [ ! -f /persistent/native-seeded ]; then
  echo 'Initializing fresh PasarGuard data'
  if [ -f /persistent/native-data/pasarguard-empty-backup.db ]; then
    # Resume a fresh initialization that stopped after the new owner was created.
    /home/container/.venv/bin/python -c "import sqlite3; c=sqlite3.connect('/persistent/native-data/pasarguard.db'); assert c.execute('select count(*) from users').fetchone()[0] == 0; assert c.execute('select count(*) from admins').fetchone()[0] == 1"
    cp /home/container/native-fresh.db /persistent/native-data/pasarguard-empty-backup.db
  else
    bash /home/container/seed-native.sh
  fi
  /home/container/.venv/bin/python /home/container/repair-native-schema.py
  touch /persistent/native-seeded
fi
touch /home/container/pasarguard-native/data/runtime-writes.enabled
/home/container/.venv/bin/python /home/container/wait-seed-services.py &
node /home/container/ovpn-bridge.js &
node /home/container/ws-tcp-bridge.js &
exec node /home/container/index.js
