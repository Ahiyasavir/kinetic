# Smart-station INPUT COOLDOWN (mobile): lock the code field for 60s after 3 wrong codes
goal: stations
risk: 2

EXTEND the EXISTING apps/mobile/app/smart-station.tsx code-entry flow (it calls `submitStationCode` and
gets back `{ correct }`). Client-side anti-brute-force only — no backend changes.

1. Keep a local counter of CONSECUTIVE wrong-code submissions (reset on a correct code).
2. On the 3rd consecutive wrong code, disable the code input AND the "Verify" button for 60 seconds.
3. While locked, show a live countdown inside the card:
   EN: "📟 Locked for guessing (45s)"   HE: "📟 המקלדת נעולה לניחושים (45 שנ')"
   (count down each second; re-enable automatically at 0 and reset the counter).

Keep EN/HE parity (i18n keys), RTL-safe, premium theme. Don't block the rest of the screen (hint button,
back navigation) — only the code field + verify button. Acceptance: three wrong codes in a row lock the
field with a visible per-second countdown for 60s, then it unlocks; a correct code before the 3rd clears
the counter; the lock is purely client-side and survives neither remount nor app restart (acceptable).
