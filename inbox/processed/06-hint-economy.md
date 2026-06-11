# Smart-station HINT ECONOMY: pay-per-hint with idempotent charging (server) + hint button (mobile)
goal: stations
risk: 3

The app ALREADY has a global `requestClueHint` callable (functions/src/index.ts ~1827) that deducts
points into `gameState.bonusPenalty`. EXTEND that pattern for a PER-TASK smart-station hint — reuse the
existing bonusPenalty mechanism and the existing hint content fields on the task (Task has `locationHint`
/ SmartStationConfig content; use the task's hint text). Do NOT invent a new scoring path.

Server (`unlockTaskHint` callable, taskId):
- Track per-task unlock on the team's gameState (server-write-only), e.g. `gameState.hintsUnlocked[taskId] = true`.
- If already unlocked → return the hint text WITHOUT charging again (idempotent).
- If not → in a transaction, set the flag, add the task's hint cost (default 15; read from
  `task.smart.hintCost` if present) to `gameState.bonusPenalty`, and return the hint text.

Client (apps/mobile/app/smart-station.tsx):
- If the team has been on the active green slot for > 5 minutes, show a subtle button:
  EN: "💡 Need a hint? (Costs 15 pts)"   HE: "💡 צריך רמז? (יעלה 15 נקודות)".
- On press, open a confirm modal:
  EN: "Unlocking this hint will deduct 15 points from this task's score. Confirm?"
  HE: "פתיחת הרמז תוריד 15 נקודות מניקוד המשימה. האם לאשר?"
- On confirm, call `unlockTaskHint` and reveal the returned hint text. If already unlocked, just show it.

EN/HE parity, RTL-safe, premium theme. gameState/score stay server-only. Acceptance: after 5 min the hint
button appears; confirming deducts the cost once (re-opening shows the hint free, no double charge) and
the hint text is shown; declining the modal charges nothing.
