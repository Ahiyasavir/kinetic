# Smart-station GEOFENCE (server): reject station-code submissions made too far from the station
goal: stations
risk: 3

EXTEND the EXISTING smart-station verification — do NOT build a new one. The real function is
`submitStationCode` in functions/src/index.ts (~line 2758); it validates the code against
`artifacts/{APP_ID}/stationSecrets/{taskId}` and calls `completeSmartStation` on success. Reuse the
existing Haversine helper already used in routing/assignNextTask.ts — do not write a second one.

GOAL: stop teams from sharing the station code over WhatsApp by requiring they be physically near the
station (anti-cheat "Geofencing Lite").

Backend changes only this slice:
- Add an OPTIONAL `location?: { lat: number; lng: number; radiusMeters: number }` to the
  `SmartStationConfig` interface in packages/shared/src/types/index.ts (optional → existing seeded
  stations without it keep working unchanged).
- In `submitStationCode`, accept optional `lat`/`lng` numbers in the payload (in addition to taskId+code).
- If (and only if) the task's `smart.location` is set: compute Haversine distance between the team's
  reported {lat,lng} and `smart.location`. If distance > `radiusMeters` (default 50) → FAIL with a typed
  error code `OUT_OF_BOUNDS` (functions.https.HttpsError 'failed-precondition' with details code
  'OUT_OF_BOUNDS'). If the client sent NO coordinates but the station requires location, fail with
  `LOCATION_REQUIRED`.
- SECURITY: never return the station's real coordinates or the measured distance to the client on
  failure. Keep the secret code server-only as today.
- If `smart.location` is unset, behave EXACTLY as today (no location check).

Acceptance: a submitStationCode call with correct code but coordinates >50 m from a location-enabled
station is rejected with OUT_OF_BOUNDS and the slot is NOT completed; the same correct code within the
radius (or a station with no location configured) still completes as before. typecheck + admin build
stay green; no client changes this slice.
