#!/bin/sh
# PasarGuard native backend is gated OFF to keep the 308MB RAM plan healthy.
# Re-enable: touch /home/container/.enable-pasarguard-native && restart server.
# (panel data remains intact in pasarguard-native/data)
if [ -f /home/container/.enable-pasarguard-native ]; then
  exec /bin/sh /home/container/pasarguard-native/run-native.sh.real "$@"
fi
exec sleep infinity
