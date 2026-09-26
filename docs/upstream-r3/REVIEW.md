# R3 independent review

Baseline: `2d048f9d`; worktree: `/Users/luo/Documents/github/codex-host-r1`.

## Reviewer identity

Native `collaboration` role `reviewer`, configured by `/Users/luo/.codex/agents/reviewer.toml`: `model = "gpt-6-astra"`, `model_reasoning_effort = "high"`, read-only. Actual session `01a0dbff-153d-7083-a717-95d71c3b1681` recorded `gpt-6-astra / high` in both initial and full-review `turn_context` events. No CLI substitute or model-name-only claim.

## Full-review findings

| ID | Severity | Trigger and impact | Required repair | Status |
| --- | --- | --- | --- | --- |
| R3-F1 | P1 | Settings RPCs still require a Composer; a cold Settings window with a connected local registry never becomes ready. | Explicit stable local Settings client; connection readiness separate from Composer send routing; production adapter + routing + Settings regression. | Closed by Astra repair review |
| R3-F2 | P1 | Multiple Hosts share active catalog/availability; local missing Agent can disable or reset a remote Composer. | Catalog, picker, availability and automatic fallback scoped to mounted Host; refresh all mounted Hosts. | Closed by Astra repair review |
| R3-F3 | P2 | Per-Host client bypasses the single usage relay; queries fail with multiple Composers and notifications can be labeled with the receiving route. | Preserve existing usage behavior using per-Host queries/subscriptions and connection-generation guards. No new billing/usage feature. | Closed by Astra repair review |
| R3-F4 | P2 | A retired policy throws during dispose, skipping valid policies and leaving the current bridge carrier selected. | Independent policy cleanup with unconditional set cleanup; old/new connection disposal regression. | Closed by Astra repair review |

In the initial full review, no additional actionable finding was reported for U10 CDP target filtering, identity-set comparison, send-control replacement, or U30 update polling. The reviewer performed a read-only code/call-chain review and did not execute validation commands.

## Evidence corrections

The release-link E2E now uses a URL accepted by the existing update schema. It proves the UI consumes `check.releaseNotesUrl` and hides absent links. Backend GitHub release source/schema remain unchanged; arbitrary fork release sources are not claimed.

During repair validation, the production cross-layer fixture also exposed that `setAdapter` retried ownership only when exactly one Composer was connected. The Renderer owner changed initialization to retry ownership for every connected Composer with its own Host. This is included in the F2/F3 repair and final re-review, not treated as an unrelated feature.

## Repair-review finding

R3-F5 (P2): Settings now returns a route-bound local client, but Updates polling retained the first client forever, including the manual status retry after 320 attempts. A replacement connection could never deliver terminal status. Root changed each bounded status read to reacquire the current local client; absence remains unknown and schedules the next bounded poll. Start is never repeated. Added succeeded/failed reconnection cases and strengthened the existing polling-limit retry case to swap the client.

The host-catalog unit fixture also needed its fake picker to expose the required `agents` property and update it during replacement. The reviewer verified this is an existing mandatory production contract. Only the fixture was corrected; production validation was not weakened.

Final incremental review passed: F1–F5 closed, no remaining actionable P1/P2. Reviewer validated all 25 hashes against the final manifest. Actual full and repair review turns in the same native session each recorded `gpt-6-astra / high`; final repair turn `01a0dc14-0574-7c02-9e7a-952d5ce2a7d4`. Root then revalidated all 25 hashes before local commits. Final build/typecheck/lint passed; scoped Vitest total 253 and Playwright total 25 passed across the documented runs. No source edits followed final review. Candidate: 25 production/test files in [review-candidate.json](review-candidate.json). Initial 23-file snapshot retained in [review-initial-candidate.json](review-initial-candidate.json).
