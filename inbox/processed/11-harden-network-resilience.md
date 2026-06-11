# HARDENING Slice 1: smart-station network resilience — graceful offline + auto-retry, no raw rejections
goal: reliability
risk: 3

PRODUCTION HARDENING (no new features, no UI redesign). EXTEND the EXISTING code entry flow in
apps/mobile/app/smart-station.tsx — it calls the `submitStationCode` callable (and the per-task hint
callable built earlier). Harden the network path; do not change the visual design beyond the required
status indicator.

Requirements:
- Catch errors from `submitStationCode` / the hint callable that are specifically network / offline /
  timeout / 'unavailable' / 'deadline-exceeded' failures (distinguish them from real app errors like a
  wrong code — those keep their existing handling).
- On a network failure: keep the code input + Verify button LOCKED and show a clear bilingual indicator
  in the card: EN "Connection weak. Retrying…" / HE "הקליטה חלשה. מנסה שוב…".
- Auto-retry the SAME submission with exponential backoff (e.g. 1s, 2s, 4s, cap ~30s) until the network
  recovers, then complete normally; stop retrying and restore the UI if the user navigates away.
- NO unhandled promise rejections anywhere on this path (every await is wrapped). A wrong-code or
  out-of-bounds response is NOT a network error and must not trigger the retry loop.

EN/HE parity (i18n), RTL-safe, premium theme unchanged. Acceptance: with the device offline a verify
attempt shows "Connection weak. Retrying…" and auto-completes once connectivity returns, with no console
unhandled-rejection and no lost input; a normal wrong-code response still shows the normal error.
