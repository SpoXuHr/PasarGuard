# PasarGuard

Source and assets for the independent PasarGuard panel, with a clean database template and a Linux Docker installation. No current users, credentials, traffic, VPN private keys, or production databases are included. First boot on a **new** volume creates a new administrator and initializes the panel's services and groups.

## Quick installation on a Linux VPS

Requirements:

- Linux **x86_64 / amd64**, Docker Engine and the Docker Compose v2 plugin, plus `git` and `curl`. The bundled VPN-UI and helper binaries are amd64; ARM and other operating systems are not supported by this release.
- Internet access to Docker Hub, GitHub and Python package sources during build/startup. Allow at least 1 GB RAM (2 GB recommended), and several GB of free disk for Docker layers and persistent data.
- An externally reachable IPv4 address; allow TCP port 20004 and, for UDP protocols, UDP port 20004 in both the server firewall and hosting-provider firewall. The port must not already be in use. Your provider must allow inbound TCP/UDP; this is not guaranteed on all platforms.
- This repository is **public** and can be cloned without GitHub authentication. Never add passwords, tokens, private keys or panel databases to the repository.

Clone the repository and choose **one** access mode:

```sh
git clone https://github.com/SpoXuHr/PasarGuard.git
cd PasarGuard
sudo ./install.sh             # HTTPS (default; certificate is self-signed)
# OR, if plain HTTP is explicitly needed:
sudo ./install.sh --http      # http://SERVER_IP:20004/TeamGuccI/
```

The HTTP command is an alternative, not an additional step. **HTTP is unencrypted:** passwords, session tokens and subscription links can be intercepted or altered. Do not use it over an untrusted network; use a protected network or a properly secured HTTPS reverse proxy. Enabling HTTPS on an outer proxy alone does not protect an openly exposed HTTP backend.

The installer detects the public IPv4 address, generates a unique random administrator password, stores configuration in a private `.env` file, builds the image, starts Docker Compose, and waits for the native API to respond. It prints the panel and dashboard URLs with the selected scheme. Username: `GUCCi`. To see the generated password on a root-run installation:

```sh
sudo grep '^ADMIN_PASSWORD=' .env
```

Keep `.env` private. It is ignored by Git and excluded from the Docker build context. A repeated installation preserves the existing `.env` and Docker volume; it does **not** reset users or traffic. Deleting the volume destroys the panel's users, configuration, keys and traffic: do not run `docker compose down -v` unless you intend to permanently erase that data. Back up the volume separately before upgrades.

If automatic IP detection is wrong (for example, NAT or differing ingress and egress IPs), or if you want a domain to be used as the advertised address, run **on the first install**, using your own values:

```sh
sudo PASARGUARD_HOST=YOUR_PUBLIC_IP_OR_DOMAIN PASARGUARD_PORT=20004 ./install.sh --http
```

`PASARGUARD_HOST` accepts a hostname or IPv4 address, not a URL. Host and port are captured when `.env` is first created. The host must resolve/reach this server. The port must be free. Docker Compose publishes that same port for TCP and UDP. For an existing installation, update host/port carefully and rebuild/recreate without deleting the volume. Test all links after any network change.

To change only the access mode on an **existing installation**, use `sudo ./install.sh --http` or `sudo ./install.sh --https`. The container is recreated, causing a brief interruption, but the installer retains the existing administrator password, users, settings and volume. Back up the volume before making changes. Running `sudo ./install.sh` without a mode keeps the existing mode; older installations without a scheme setting default to HTTPS. The installer prints the appropriate URL and the subscription origin follows the selected scheme.

### TLS and security

In HTTPS mode the default VPS panel uses a **self-signed certificate**, not a publicly trusted certificate. Browsers and subscription clients will show warnings or reject it. Verify its SHA-256 fingerprint through a trusted administrative channel; accepting an unverified certificate is vulnerable to impersonation. HTTP mode provides no encryption or server identity verification. For production, configure a trusted HTTPS reverse proxy using a domain and valid certificate, with the direct backend protected by network access controls. Do not assume that a generic HTTPS proxy automatically transports raw OpenVPN or other TCP protocols.

For example, retrieve the certificate fingerprint locally on the server, after startup:

```sh
sudo docker compose exec pasarguard node -e "console.log(new (require('crypto').X509Certificate)(require('fs').readFileSync('/persistent/vpn-data/edge-tls/edge.crt')).fingerprint256)"
```

The address of the server and whether the public port is filtered are determined by the host/network. The generated VLESS/VMess/Trojan TCP and Shadowsocks links were tested locally on Docker; WebSocket links over a trusted port 443 are not automatically supplied in the generic VPS mode. A separately configured domain and HTTPS edge are needed for that deployment pattern.

### Lifecycle and limitations

```sh
sudo docker compose ps
sudo docker compose logs --tail=100 -f
sudo docker compose restart
sudo docker compose stop
sudo docker compose up -d
```

A Docker volume persists the database, VPN state and certificates across restarts. Docker's `unless-stopped` policy restarts the service after daemon/host restarts unless intentionally stopped. It is not a backup.

An isolated Docker test built the image, initialized a fresh panel with zero users, logged in successfully, passed traffic over Shadowsocks/VLESS/Trojan/VMess TCP, and retained a test user across a container restart. OpenVPN TCP and UDP passed certificate verification and authentication up to `PUSH_REPLY`; full TUN/data forwarding and individual WireGuard, AmneziaWG, Hysteria 2, and Telegram clients were **not** verified. On initial startup the UDP mux may log a warning when profiles are empty or incomplete. Check actual service logs and test the protocols you need; opening a UDP port alone does not establish that all UDP protocols work.

## Existing Railway deployment

For Railway, deploy the Dockerfile service and attach a **new** volume at `/persistent`. Never reattach an existing panel's volume. Set `ADMIN_PASSWORD`, `PORT`, `SERVER_PORT`, `PYTHONDONTWRITEBYTECODE=1` and `PUBLIC_TLS=0`. Create a Railway service domain and TCP Proxy targeting the application port. Set `PG_MANAGED_SUB_ORIGIN` to the service HTTPS origin, `PANEL_HOST` to the TCP proxy domain, and `RAILWAY_ADVERTISED_PORT` to its external port. Railway supplies `RAILWAY_VOLUME_MOUNT_PATH` and `RAILWAY_PUBLIC_DOMAIN`. See the platform's networking and volume requirements before deploying.

Railway's HTTPS edge does not carry raw OpenVPN TCP; use its TCP Proxy, or a separate WebSocket helper on the client. Railway does not provide public UDP forwarding through the TCP proxy. The legacy `setup.sh` is not the deployment method described above.

The base image downloads VPN-UI v1.9.4 at build time and verifies its pinned SHA-256. Other pinned dependencies are installed at build time; ongoing availability and every future platform or network cannot be guaranteed.
