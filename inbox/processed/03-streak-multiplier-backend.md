# Smart-station SPEED STREAK (server): consecutive fast verifications grant a 1.5x score multiplier
goal: stations
risk: 3

EXTEND the EXISTING `completeSmartStation` helper in functions/src/index.ts (~line 2721) — it already
computes `calculateTaskScore(difficulty, actualMins, estMins)` and writes the slot's earnedScore +
gameState.score in a transaction. Add a "Speed Combo" without changing the base scoring path.

Server logic (inside the existing completeSmartStation transaction, on success):
- Store an `activeCombo` object on the team's gameState (…/users/{teamId}/gameState/current):
  `{ streak: number, lastVerifiedAt: ISO string }`. (gameState is server-write-only — correct place.)
- If `lastVerifiedAt` exists and is within the last 10 minutes (make the window a const, default 600s),
  increment `streak` by 1; otherwise reset `streak` to 1. Always set `lastVerifiedAt` = now.
- If the resulting `streak >= 3`, multiply the computed task score by 1.5 (make the multiplier + threshold
  consts). 
- TRANSPARENCY: store the RAW base score and the multiplied/bonus amount SEPARATELY in the completed
  slot's scoreBreakdown (e.g. add `comboMultiplier` and `comboBonus` fields) so the leaderboard is
  auditable; the slot total reflects the multiplied score.
- Only smart-station completions feed the streak; judge/gate/basket completions are unchanged.

Acceptance: completing 3 green smart-stations within 10 min of each other makes the 3rd (and onward,
while the streak holds) award 1.5x its base task score, with raw + bonus visible in the slot breakdown;
a gap >10 min resets the streak to 1; existing single-station scoring is unchanged. typecheck + admin
build green. (Client "ON FIRE" UI is a SEPARATE later task — backend only here.)
