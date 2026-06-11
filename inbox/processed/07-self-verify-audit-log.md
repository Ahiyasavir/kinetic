# Smart-station AUDIT LOG: record every verification attempt to a self_verify feed for live monitoring
goal: admin
risk: 2

EXTEND the EXISTING `submitStationCode` callable (functions/src/index.ts ~2758). On EVERY attempt —
success or failure — append one audit document to `artifacts/{APP_ID}/public/data/self_verify` using
the FIRESTORE_PATHS helpers (never hardcode the path). Use the project's existing audit-write style
(see how auditLogs / adminAlerts are written) and the Admin SDK (server-side only).

Each document:
{
  teamId, taskId,
  status: 'SUCCESS' | 'WRONG_CODE' | 'OUT_OF_BOUNDS' | 'LOCATION_REQUIRED',
  timestamp: ISO,
  inputProvided: <the submitted code, TRUNCATED to ~12 chars for audit>,
  gpsCoords: { lat, lng } | null   // only what the client sent; omit if none
}

Write the log on each branch of submitStationCode (correct, wrong code, out-of-bounds, location-required)
BEFORE returning. Do not fail the verification if the audit write fails (wrap in try/catch — logging is
best-effort and must never block a real verification). No client changes required for this slice.

Acceptance: every call to submitStationCode (correct or not) creates exactly one self_verify document
with the right status and a truncated input; a failed audit write does not break verification; the
collection is readable by an authed admin for a future live-monitor view.
