# iPhone GPS Companion — implementation plan

Status: development only. Do not deploy or switch passenger tracking yet.

## Goal
Use the driver's iPhone as a location source during an entire driving shift while Uber remains foregrounded. The passenger iPad stays on Pax Control. Tesla continues to provide the navigation destination when needed, with drastically fewer Fleet API reads.

## Constraints
- A normal Safari page cannot reliably track location in the background. Build a native iOS companion (Swift/SwiftUI, Core Location).
- The driver explicitly starts a shift once and ends it once. No per-ride interaction.
- Use Core Location background mode and request appropriate location authorization. Background execution is subject to iOS limits and permissions. Force quitting can stop updates.
- Do not assume access to Uber's trip state or automatic ride detection.
- Wi-Fi-only passenger iPad reads GPS coordinates from the existing Railway backend.
- Protect location endpoints with driver-only authentication; never expose live coordinates to arbitrary visitors. Do not log raw coordinates or include them in public repositories.
- Expire stale locations, stop sharing at shift end, and make the active sharing state visible to the driver.
- Do not change existing Spotify, Tesla controls, voice announcements, or ride state.

## Backend work
1. Add authenticated POST /api/driver/location with latitude, longitude, accuracy, timestamp, and shift identifier. Reject out-of-range coordinates, stale timestamps, and excessive updates.
2. Add authenticated start/stop shift endpoints and GET /api/driver/location for authorized passenger sessions.
3. Keep last GPS fix in server state with timestamp and freshness. If multiple Railway replicas or restarts are used, persist in shared storage.
4. Rate-limit Tesla navigation reads and cache destination/ETA; do not tie each iPad refresh to a new Tesla Fleet API call.
5. Return a clear stale/unavailable state when the iPhone stops updating.

## iOS work
1. Native SwiftUI app with Start Shift / End Shift and a visible sharing indicator.
2. Core Location background updates while shift is active; appropriate accuracy, distance filter, and battery-saving behavior.
3. Securely store a scoped API credential in Keychain, never in source.
4. Send batched/throttled HTTPS location updates and retry gracefully.
5. Explain permissions and give a clear way to stop sharing.

## Passenger app work
1. Prefer fresh iPhone location for the car marker.
2. Continue showing destination from Tesla's navigation cache.
3. Arrival speech remains once per ride; use an updated, reliable ETA source and avoid triggering on stale estimates.
4. Show tracking status without revealing driver-only settings.

## Test gates
- iPhone app backgrounded while Uber is foregrounded
- Locked screen, weak signal, network interruptions, force-quit behavior
- No passenger GPS exposure without authorization
- Tesla billing request counts measured before and after
- Regression tests for Spotify, climate, welcome, and arrival

Do not merge into main until these checks pass.
