#!/bin/sh
# ---------------------------------------------------------------------------
#  Manual binary fetch - only needed if the new host image does not ship the
#  VPN stack and vpn-ui could not unpack it on first boot.
#
#  index.js downloads VPN-UI itself (346 MB) and VPN-UI then unpacks Xray and
#  telemt next to it.  This script is the fallback for the pieces that come
#  from the host image.
# ---------------------------------------------------------------------------
set -eu
BIN=/home/container/vpn/bin
mkdir -p "$BIN" /home/container/vpn/openvpn/bin
cd /tmp

echo "== vpn-ui (346 MB, the same release the panel uses) =="
if [ ! -x /home/container/vpn/vpn-ui-amd64 ]; then
  curl -fL --retry 3 -o /home/container/vpn/vpn-ui-amd64.download \
    https://github.com/Sir-MmD/vpn-ui/releases/download/v1.9.4/vpn-ui-amd64
  mv /home/container/vpn/vpn-ui-amd64.download /home/container/vpn/vpn-ui-amd64
  chmod +x /home/container/vpn/vpn-ui-amd64
fi

echo "== tun2socks (OpenVPN side-car) =="
if [ ! -x "$BIN/tun2socks" ]; then
  curl -fL --retry 3 -o t2s.zip \
    https://github.com/xjasonlyu/tun2socks/releases/download/v2.7.0/tun2socks-linux-amd64.zip
  unzip -oq t2s.zip -d "$BIN"
  chmod +x "$BIN/tun2socks" 2>/dev/null || true
fi

echo "== Xray core (only if vpn-ui did not provide it) =="
if [ ! -e "$BIN/xray-official" ]; then
  curl -fL --retry 3 -o xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip
  unzip -oq xray.zip -d /tmp/xray-unpack
  cp /tmp/xray-unpack/xray "$BIN/xray-official"
  chmod +x "$BIN/xray-official"
fi

echo "== result =="
ls -l "$BIN" | head -20
echo
echo "NOTE: telemt (MTProto) is unpacked by VPN-UI on first boot; the geoip/geosite"
echo "      files are downloaded by Xray/VPN-UI when needed."
