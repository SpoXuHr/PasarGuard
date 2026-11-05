FROM node:22-bookworm-slim AS node
FROM python:3.14-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip procps && rm -rf /var/lib/apt/lists/*
WORKDIR /home/container
COPY requirements-freeze.txt ./
# Build the python venv / native deps from the upstream release so the image
# never depends on a large in-image payload.
RUN python -m venv /home/container/.venv \
 && .venv/bin/pip install --no-cache-dir --target /home/container/pasarguard-native/pylibs -r requirements-freeze.txt webauthn \
 && .venv/bin/pip install --no-cache-dir --no-deps --upgrade --target /home/container/pasarguard-native/pylibs pasarguard-node-bridge==0.9.4
COPY . /home/container/
# vpn-ui binary + python app+dashboard are fetched from the official release at
# build time (the old image carried 330 MB of binaries in the source tree).
RUN set -eu; \
    mkdir -p /home/container/vpn/bin /home/container/pasarguard-native/data /home/container/vpn/data /tmp/rel; \
    curl -fL --retry 3 --connect-timeout 30 --max-time 900 \
      https://github.com/Sir-MmD/vpn-ui/releases/download/v1.9.4/vpn-ui-amd64 -o /home/container/vpn/vpn-ui-amd64; \
    echo '18ec321d9074b319bd5756508bbc523ab5d95450b832c406acdd72e987a2da8f  /home/container/vpn/vpn-ui-amd64' | sha256sum -c -; \
    chmod +x /home/container/vpn/vpn-ui-amd64; \
    chmod +x /home/container/entrypoint.sh /home/container/start.sh
ENV RAILWAY_STATE_FILE=/persistent/state.json PYTHONUNBUFFERED=1
# start.sh re-installs the runtime patch if one is present, then hands over to
# the original entrypoint.
CMD ["sh", "/home/container/start.sh"]
