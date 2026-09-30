# R3 Desktop stability execution

Worktree: `/Users/luo/Documents/github/codex-host-r1`; branch `codex/upstream-r1`.
R3 baseline: `2d048f9d`. Original fork baseline: `af255feb`.
User authorized local batch commits, R3 implementation, native reviewer role full review, and repair of all findings. No push/PR/release. Do not restart Desktop; use headless fixtures and read-only inspection of an already running Desktop.

## Incoming batches

- `b1068965`: R1 native routing, history transport, discovery, package integrity and DSH journal fixes.
- `1998ef02`: R2 fork permissions, lock identity, child runtime and cancellation boundaries.
- `08dd08b7`: R2 OMP/Pi/OpenCode adapter reliability.
- `41b47bdb`: R2 Launcher/Controller attachment recovery.
- `2d048f9d`: upstream research and R1/R2 evidence, including completed Astra review repairs.

## Scope and ownership

Authority: docs/upstream-comparison-20260926/{README,tasks,desktop-renderer}.md. Scope only U09, U10, U30. No CodeBuddy, accounts, quotas/Usage feature development, history import, new Harness, model favorites, or unified mention menu.

- Root: U09 desktop-control discovery/prewarm/routing side, integration, shared contracts only if necessary, validation orchestration and all commits/docs.
- Renderer owner: U09 renderer Host clients vs Composer routing, draft identity/selection/sidebar correctness; U10-c live send button rebind. Own renderer binding/adapter/selection/composer files and related unit/e2e tests, excluding settings pages/update-request. Communicate cross-package interface needs before changes.
- CDP owner: U10-a identity-set comparison in renderer-cdp-control-session; U10-b attachable target selection in cdp-client; corresponding desktop-control tests only.
- Update owner: U30 settings/pages and update-request + related tests; start timeout keeps observing update status, avoids duplicate starts and uses the release URL returned by the existing update check (no UI fallback; backend release source remains unchanged). No actual upgrade.
- Independent review: `/Users/luo/.codex/agents/reviewer.toml`, actual runtime must be GPT-6 Astra/high. Read-only whole R3 diff and affected callers; root repairs every actionable finding.

## Completion and validation

Read current code and frozen upstream evidence, adapt behavior without wholesale copied bindings. Preserve browser-safe/package ownership boundaries, plugin capability truth and existing double draft IDs. Unit fixtures cover absent Composer, local/remote and multiple editors, draft replacement/locked Thread/disconnection; catalog reorder vs real change; bad target before valid; live button replacement without duplicate controls/listeners; update timeout/terminal failure/reconnection/click deduplication. Build/typecheck/lint from package.json, affected Playwright fixture rendering and interactions, and read-only Desktop contract audit where available. No fabricated native validation if ports/environment unavailable. Prior passed R1/R2 evidence applies only to unchanged bytes.

Commit R3 in coherent functional batches after validation and final review fixes. End with clean worktree, review record, exact test evidence, and explicit unrun native boundaries.

## Delivered R3 batches

- `b62046eb`: CDP attachable targets and Agent identity-set reinjection guard.
- `e380a43c`: Host connection/Composer routing separation, per-Host isolation, live controls, F1–F4 repairs and regressions.
- `1568ba38`: Update observation across timeout/disconnection, release-link source, F5 repair and regressions.
- Documentation batch (`docs: record R3 validation and Astra review closure`): result, review, candidate hashes, read-only Desktop audit and screenshots.

F1–F5 all closed by native Astra/high review. Final source hashes preserved after review. Validation details and native limitations: [RESULT.md](RESULT.md). No push, PR, release, actual update or Desktop restart.
