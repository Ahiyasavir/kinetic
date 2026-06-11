# Smart-station GEOFENCE (mobile): send GPS with the station code + clean bilingual location errors
goal: stations
risk: 3

Builds on the geofence backend slice (submitStationCode now accepts lat/lng and can return
OUT_OF_BOUNDS / LOCATION_REQUIRED). EXTEND the EXISTING screen apps/mobile/app/smart-station.tsx —
it already calls the `submitStationCode` callable with { taskId, code }. Reuse the existing device
location hook (src/hooks/useDeviceLocation / useAdaptiveLocation) — do not add a new geolocation lib.

When the player presses "Verify & Advance":
1. Request the current device GPS (lat/lng) and include it in the submitStationCode payload.
2. If location permission is denied or unavailable, show a clean bilingual Toast and do NOT submit:
   EN: "Location access is required to verify stations. Please enable GPS."
   HE: "נדרשת גישת מיקום כדי לאמת תחנה. אנא הפעל GPS."
3. On an OUT_OF_BOUNDS response, show a clear bilingual message that they are too far from the station
   (EN: "You're too far from the station — get closer and try again." / HE equivalent). Never display
   any distance/coordinates (the server doesn't send them).

Keep EN/HE parity (add keys to src/i18n), RTL-safe logical classes, and the existing premium theme.
Stations without a configured location must still verify exactly as today. Acceptance: on a
location-enabled station a player near it verifies normally; far away they get the bilingual
"too far" message; with GPS denied they get the enable-GPS toast and no submit happens.
