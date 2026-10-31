# Tesla driver diagnostics — implementation specification

Status: isolated development branch; not deployed.

## Driver dashboard indicator
Display three read-only fields:
- Gear: Park / Drive / Reverse / Neutral / Unknown.
- Distance to destination: feet (or "Unavailable").
- Data status: Fresh / Stale / Unavailable, with age of last successful update.

## Data and safety rules
- Use the existing server-side Tesla Fleet API integration, not direct access from the Tesla browser.
- Read drive_state.shift_state and drive_state.latitude/longitude when available; use the existing navigation destination coordinates to calculate straight-line distance.
- Do not treat a missing field as Park or zero distance.
- Mark vehicle data stale after 30 seconds without a successful update.
- Never clear passenger details or trigger trip completion from the diagnostic component.
- Do not expose VIN, tokens, raw location, or secrets in logs or browser responses.
- Keep passenger map, Spotify, and existing arrival logic unchanged.

## Validation
1. Confirm Park/Drive matches the Tesla display while safely stationary.
2. Confirm distance changes toward a known destination.
3. Simulate API missing fields and confirm "Unavailable" is shown.
4. Confirm the working October 29 Railway deployment is not changed.
