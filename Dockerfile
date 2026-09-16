# ---- Tesla Vehicle Command binary ----
FROM tesla/vehicle-command:latest AS tesla

# ---- Pax Control ----
FROM node:24-bookworm-slim

WORKDIR /app

# We need OpenSSL to create a LOCAL-ONLY TLS certificate
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Tesla's official HTTP proxy from its image
COPY --from=tesla /usr/local/bin/tesla-http-proxy /usr/local/bin/tesla-http-proxy

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Startup script
RUN printf '%s\n' \
'#!/bin/sh' \
'set -eu' \
'' \
'mkdir -p /data/tesla-proxy' \
'' \
'# Restore the EXISTING paired Tesla private key' \
'if [ -n "${TESLA_PRIVATE_KEY_B64:-}" ]; then' \
'  printf "%s" "$TESLA_PRIVATE_KEY_B64" | base64 -d > /data/private-key.pem' \
'  chmod 600 /data/private-key.pem' \
'else' \
'  echo "TESLA_PRIVATE_KEY_B64 is missing"' \
'  exit 1' \
'fi' \
'' \
'# Create a completely separate TLS key/certificate for localhost proxy' \
'if [ ! -f /data/tesla-proxy/tls-key.pem ] || [ ! -f /data/tesla-proxy/tls-cert.pem ]; then' \
'  openssl req -x509 -nodes -newkey ec \' \
'    -pkeyopt ec_paramgen_curve:secp384r1 \' \
'    -pkeyopt ec_param_enc:named_curve \' \
'    -subj "/CN=localhost" \' \
'    -keyout /data/tesla-proxy/tls-key.pem \' \
'    -out /data/tesla-proxy/tls-cert.pem \' \
'    -sha256 -days 3650 \' \
'    -addext "extendedKeyUsage = serverAuth" \' \
'    -addext "keyUsage = digitalSignature,keyCertSign,keyAgreement"' \
'  chmod 600 /data/tesla-proxy/tls-key.pem' \
'fi' \
'' \
'# Tesla proxy is LOCALHOST ONLY' \
'tesla-http-proxy \' \
'  -tls-key /data/tesla-proxy/tls-key.pem \' \
'  -cert /data/tesla-proxy/tls-cert.pem \' \
'  -key-file /data/private-key.pem \' \
'  -host 127.0.0.1 \' \
'  -port 4443 \' \
'   2>&1 &' \
'' \
'echo "Tesla command proxy started on localhost:4443"' \
'' \
'exec npm start' \
> /usr/local/bin/start-pax-control \
&& chmod +x /usr/local/bin/start-pax-control

ENV NODE_ENV=production

EXPOSE 3000

CMD ["/usr/local/bin/start-pax-control"]
