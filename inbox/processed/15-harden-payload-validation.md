# HARDENING Slice 3b: strict payload validation at the top of the smart-station callables
goal: reliability
risk: 3

PRODUCTION HARDENING. EXTEND the EXISTING smart-station Callable Functions (`submitStationCode`, the
hint-unlock callable, and any other team-facing smart-station callable) in functions/src/index.ts. Add
strict input validation as the FIRST thing each does, before any Firestore read.

Requirements:
- Validate every incoming field's TYPE and reasonable LENGTH:
  - `taskId`: required non-empty string, length ≤ 200, no control chars.
  - `code`: required string (where applicable), length ≤ 200.
  - `lat`/`lng` (where applicable): finite numbers in range (covered by Slice 3a — keep consistent).
- On any violation, reject IMMEDIATELY with `functions.https.HttpsError('invalid-argument', …)` and a
  clear message — before touching the database. Reject oversized / wrong-type / malicious payloads up
  front so they can never reach the transaction logic or crash the function.
- Do NOT change behavior for well-formed requests; this only rejects malformed ones earlier and more
  clearly than today.

Keep it DRY where natural (a small shared validator helper is fine) but do not over-refactor. Acceptance:
calling these functions with a missing/empty/non-string taskId, a 10k-char code, or a wrong-typed field
returns invalid-argument immediately with no DB access; well-formed calls behave exactly as today.
typecheck + admin build green.
