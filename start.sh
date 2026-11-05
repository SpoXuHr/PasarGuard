#!/bin/sh
# PasarGuard entrypoint: restores the runtime patch from the volume when present,
# then hands over to the standard entrypoint.
set -eu
if [ -s /persistent/patch/index.js ] && ! cmp -s /persistent/patch/index.js /home/container/index.js; then
  cp -f /persistent/patch/index.js /home/container/index.js
  echo '[patch] runtime index.js restored from /persistent/patch'
fi
exec sh /home/container/entrypoint.sh
