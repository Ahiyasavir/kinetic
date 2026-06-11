# HARDENING Slice 3a: Haversine / GPS fallback — bad coordinates return INVALID_LOCATION, never crash
goal: reliability
risk: 3

PRODUCTION HARDENING. EXTEND the EXISTING geofence path in `submitStationCode` and the `haversineKm`
helper (functions/src/index.ts ~2872). Bad device GPS must NOT throw an unhandled backend exception.

Requirements:
- Before computing distance, validate the client-supplied coordinates: lat/lng must be present, finite
  numbers (not null/undefined/NaN/strings) and within real-world range (lat −90..90, lng −180..180).
- If the station REQUIRES location (has a geofence configured) and the coordinates are missing or
  malformed, return a controlled typed result — reuse the existing `LOCATION_REQUIRED` path, or add a
  clear `INVALID_LOCATION` typed error (functions.https.HttpsError 'invalid-argument' / a details code)
  — NEVER an unhandled throw from `haversineKm`.
- Guard `haversineKm` itself so it can never be called with non-finite inputs (defensive check returning
  a safe sentinel or guarded by the caller).
- Stations WITHOUT a geofence are unaffected; a valid in-range coordinate behaves exactly as today.

Acceptance: submitStationCode with null / NaN / out-of-range / missing GPS at a geofenced station returns
a clean INVALID_LOCATION / LOCATION_REQUIRED status (no 500 / unhandled exception in the functions log);
a valid coordinate verifies/rejects by distance exactly as today. typecheck + admin build green.
