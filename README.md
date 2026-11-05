# PasarGuard — fresh Railway deployment

This repository contains the application source and assets used for the independent Netherlands panel. The current panel and its persistent data are not part of this repository. `native-fresh.db` is an empty schema template; it contains no administrators, users, settings, JWTs, managed bindings, or actions. A fresh deployment creates its own administrator and service state on first boot.

## Railway deployment

1. Deploy this repository as a Dockerfile service in Railway. The image downloads the VPN-UI v1.9.4 binary during build, verifies its SHA-256, and installs the Python dependencies in `requirements-freeze.txt`. Network access to the upstream dependency sources is needed at build time.
2. Attach a **new** persistent volume at `/persistent`. Never attach the existing panel's volume. Select the desired service and volume region; a country-specific address or a dedicated/fixed egress IP is not guaranteed.
3. Set these service variables:
   - `ADMIN_PASSWORD`: choose a strong, private password. The initial native administrator username is `GUCCi`.
   - `PORT` and `SERVER_PORT`: set both to `20004`.
   - `PYTHONDONTWRITEBYTECODE`: `1`.
   - `PUBLIC_TLS`: `0`.
4. Create a Railway public service domain targeting port `20004` and one Railway TCP Proxy targeting port `20004`. Set `PG_MANAGED_SUB_ORIGIN` to `https://<your-service-domain>`, `PANEL_HOST` to the proxy's assigned domain, and `RAILWAY_ADVERTISED_PORT` to its assigned external port. If necessary, redeploy this new service after setting variables. The Railway-provided `RAILWAY_PUBLIC_DOMAIN` is supplied automatically when a service domain is configured.
5. Open `https://<your-service-domain>/TeamGuccI/pasarguard/` and sign in. On first boot the new volume is initialized and the managed services/groups are seeded. Check the startup logs and actual generated links before use.

**Important limitations:** Railway's HTTPS edge does not carry raw OpenVPN TCP. OpenVPN TCP uses the TCP Proxy; OpenVPN over the HTTPS domain and port 443 requires a separate compatible client-side WebSocket helper. Railway public networking does not provide public UDP forwarding, so UDP-only protocols are not usable through the TCP Proxy. The legacy `setup.sh` is not the Railway deployment procedure above.

This export is source plus clean initialization, not a snapshot of the active panel's databases, passwords, users, subscription credentials, traffic or certificate/private keys. Existing servers are unaffected. A build from GitHub and full end-to-end operation on a newly deployed instance should be verified separately; hosted dependency versions, Railway networking, and regions can change.
