# Smart-station "ON FIRE" (mobile): animated streak badge + 3-in-a-row celebration
goal: ui
risk: 2

Builds on the streak backend slice (gameState.current now carries `activeCombo.streak`). EXTEND the
EXISTING mobile dashboard (apps/mobile/app/dashboard.tsx) and/or smart-station screen — the app already
mirrors gameState via the gameStore / useGameSync, so read `activeCombo.streak` from there (no new
Firestore reads). Reuse the existing react-native-reanimated patterns already used on the dashboard and
the existing Toast.

1. When the team's `activeCombo.streak >= 3`, render an animated badge near the team name/score:
   EN: "🔥 ON FIRE! 1.5x Active"   HE: "🔥 ברצף מטורף! פי 1.5 ניקוד"
2. The moment the streak first reaches 3 (transition 2→3), fire a celebration Toast once:
   EN: "🔥 3-in-a-row Speed Combo! +50% Bonus Score!"
   HE: "🔥 קומבו מהירות! 3 תחנות ברצף! 50%+ בונוס ניקוד!"
   (Detect the transition so it doesn't re-fire every render; e.g. compare against the previous streak.)

EN/HE parity, RTL-safe, premium theme, subtle/not-overwhelming animation. No backend changes. Acceptance:
a team at streak ≥3 sees the animated ON FIRE badge and got exactly one celebration toast when they hit
3; teams below 3 see nothing new; toggling language shows the correct localized copy.
