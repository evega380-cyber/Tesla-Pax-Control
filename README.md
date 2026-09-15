# Tesla Passenger Control — starter app

This is a private passenger interface for a Tesla Model 3. It is intentionally limited to:
- media play/pause
- previous/next track
- volume up/down
- cabin temperature 68–76°F

It does NOT expose lock/unlock, trunk/frunk, charging, location, Sentry, navigation, remote start, or other vehicle controls.

## Important architecture

iPad -> this web app -> private server -> Tesla Vehicle Command HTTP Proxy -> Tesla Fleet API -> Model 3

Tesla's current vehicle-command system uses end-to-end command authentication. The official `tesla/vehicle-command` project provides the HTTP proxy used for signing commands with your vehicle's virtual key.

## What is still required

1. A public HTTPS domain for this app.
2. A Tesla developer application with the proper redirect URI.
3. Tesla OAuth authorization and a refresh/access token.
4. A Tesla virtual-key/private-key setup using the official Tesla vehicle-command tools.
5. A secure server deployment. Do NOT put Tesla secrets or private keys in the iPad/browser.
6. Update `.env` with your real values.

## Local development

Install Node.js 20+.

    npm install
    cp .env.example .env
    npm start

The passenger UI will be available locally at:

    http://localhost:3000

## Production warning

Do not expose `tesla-http-proxy` directly to the public internet without proper client authentication. Tesla's official vehicle-command project warns that unauthorized clients could abuse an exposed proxy. Put the proxy behind the private app/server network and authenticate the passenger-facing app.

## Tesla registration URLs

Once the app has a real HTTPS domain, Tesla's developer portal should use:
- Allowed Origin URL: https://YOUR-DOMAIN
- Allowed Redirect URI: https://YOUR-DOMAIN/auth/callback

Do not invent these URLs before the app has a domain.

## Notes

The current app uses the Tesla proxy endpoints for commands. The proxy handles the end-to-end vehicle command protocol. The passenger browser never receives the Tesla access token.
