# R2 preliminary read-only review — GPT-6 Sol / medium

Dispatch correction: despite the original agent name and requested model arguments, runtime turn_context recorded gpt-6-sol / medium. This is not the required Astra / high final review. The finding below was subsequently repaired by the owner.

Scope: U05, U06, U08, U12, U16, U17, U18 at `af255feb` plus the uncommitted R2 files in `r2-files.txt`. U15/CodeBuddy is excluded. The 15 files in `r1-baseline.json` were treated as incoming R1, not R2.

## Finding

- **P2 — Report cleanup failures when Fork permission readback fails.** In `packages/host-runtime/src/external-thread-fork.ts:203-207`, `readSnapshot()` returning `!ok` closes the derived Session and removes the provisional Host Thread with both errors swallowed, then returns only the mapped read error. A failed readback can occur after selecting the source Permission Mode. If either cleanup operation fails, the response hides the surviving native Session or provisional Host record, unlike the exception path at lines 265-291. Route this branch through the same cleanup/error assembly and include the native and Host identifiers where available. Add a focused failure fixture for this branch.

## Evidence boundary

I read the final implementation and focused tests for the seven scoped items, including Fork permission/resume coverage, macOS lock identity, Controller/Launcher attachment deadline, child status transition/refresh, OMP tool events, Pi cancellation/steering, and managed OpenCode startup/cleanup. No other concrete P1/P2 finding emerged from this static review. The stale-lock rename race predates U06 and remains outside this change. Fork failure cleanup has no public native-history delete API; closing the Session and removing the provisional Host record do not prove that the native history disappeared.

I did not run tests, native Harnesses, Desktop, SSH, or platform acceptance. `RESULT.md` records the owner-run focused tests, TypeScript build/typecheck/lint, Rust tests, and their limits; this review does not independently validate those command results.
