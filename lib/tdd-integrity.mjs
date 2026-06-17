// tdd-integrity.mjs — pure decision logic for the TDD Red→Green integrity gate.
//
// THE PROBLEM THIS CLOSES: the supervisor's "GREEN gate" deterministically runs the generated test and
// blocks the cycle if it fails. But a passing test is only *proof of the change* if that same test
// FAILED on the pre-implementation baseline (true TDD Red). A vacuous/tautological test — one that
// asserts a module is merely *defined*, or `assert(true)` — passes BOTH before and after the
// implementation. It then shows "✓ GREEN" while gating nothing, granting a FALSE behavioral proof.
// (This is the exact mechanism by which latent-bug commits — e.g. a key-format mismatch that silently
// falls back to a default — passed review with a green test.)
//
// The supervisor independently runs the test ONCE against the baseline (before the implementer touches
// code) and once after (the existing GREEN gate). This module turns those two booleans into a verdict.
// It is pure (no I/O) so the policy is unit-testable in isolation.

// redVerified: true  → test ran on the baseline and FAILED  (genuinely Red — encodes a real contract)
//              false → test ran on the baseline and PASSED  (vacuous — proves nothing about the change)
//              null  → baseline run was inconclusive (runner/tooling error, or no test produced)
// greenPassed: true  → test passes after implementation
//              false → test fails after implementation
//              null  → post-implementation run was inconclusive / not run
//
// Returns { authoritative, blocking, status, note }:
//   authoritative — may a GREEN pass be COUNTED as behavioral proof of the change?
//   blocking      — must this verdict fail the cycle (revise/reject)?
//   status        — short machine label for telemetry/history
//   note          — human-readable line for logs and the reviewer's evidence block
export function classifyTestGate({ redVerified = null, greenPassed = null } = {}) {
  // No usable test at all — nothing to assert; the cycle relies on evidence + LLM review as before.
  if (greenPassed === null && redVerified === null) {
    return { authoritative: false, blocking: false, status: 'no-test', note: 'no executable test produced — gate inactive (relying on evidence + review)' };
  }

  // The test FAILS after implementation → hard block, exactly like a validation failure. (Whether or not
  // it was confirmed Red, a currently-failing test is an unambiguous problem.)
  if (greenPassed === false) {
    return { authoritative: true, blocking: true, status: 'green-fail', note: 'generated test FAILS after implementation — blocking (revise)' };
  }

  // From here greenPassed is true (or unknown-but-not-failing). Branch on the Red evidence.
  if (redVerified === true) {
    return { authoritative: true, blocking: false, status: 'red-green', note: 'test was Red on baseline and Green after implementation — authoritative behavioral proof' };
  }
  if (redVerified === false) {
    // Passed after — but ALSO passed before. The test cannot distinguish broken from fixed: NOT proof.
    // Deliberately NON-blocking: producing a meaningful test is the Tester's job, not something the
    // implementer can fix by editing source, so blocking here could deadlock the revision loop. Instead
    // we strip the test of authority and surface it LOUDLY so the LLM reviewer scrutinizes behavior.
    return { authoritative: false, blocking: false, status: 'vacuous', note: '⚠ test passed but was never Red on the baseline (vacuous/tautological) — NOT counted as behavioral proof; reviewer must verify behavior manually' };
  }
  // greenPassed true/unknown, redVerified null → baseline inconclusive. Accept the green signal but mark
  // it unverified so downstream consumers know it is weaker than a confirmed Red→Green.
  return { authoritative: false, blocking: false, status: 'green-unverified', note: 'test passed but Red baseline was inconclusive (runner error) — green signal unverified' };
}
