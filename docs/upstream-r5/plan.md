# R5 protocol-backed entry points

Worktree `/Users/luo/Documents/github/codex-host-r1`, branch `codex/upstream-r1`, baseline `ae4bcc33`. Incoming R1–R4 changes are committed and worktree started clean. User authorizes local implementation, subagents, full Astra review/repairs and batch commits. No push/PR/remote CI, deployment, Desktop restart, CodeBuddy, account/quota optimization, arbitrary history import or new Harness.

Authority: ../upstream-comparison-20260926/README.md and tasks.md U19/U20/U23/U31. Upstream reference remains `/Users/luo/Documents/github/codex-host-ori/codex-host`.

## Ownership and dependency order

- Root: shared command/catalog/mention contracts, Host admission/cache/cancellation and composition; freeze contracts before dependent Adapter/Renderer edits. Own host-runtime and shared-contracts, coordinate concrete native adapters.
- CI owner U31: workflow/cache/concurrency/platform test ownership and automation tests. Preserve complete Linux lane, anchor setup/build, package boundaries and conformance; no regex test-platform inference, no remote Actions runs.
- Model owner U23-b: model favorite persistence + picker ordering/search/removal, isolated model-picker modules/tests. No binding/probe or composer-dom writes.
- Renderer owner U20/U23-a,c: unified # menu, command/skill/delegation chip selection, existing route/binding integration, active catalog scheduling and narrow Composer layout. Do not own model-picker modules; agree with model owner on interfaces.
- Adapter owner U19-b: implement verified native metadata on two existing Adapters only after contract freeze; no hidden long-lived discovery Sessions, no SKILL.md interpretation in Host/Renderer.
- Reviewer: native role from `/Users/luo/.codex/agents/reviewer.toml`, actual GPT-6 Astra/high must be verified. Read-only comprehensive final diff and all direct behavior; all findings repaired and re-reviewed.

## Acceptance

Workspace catalog cache keyed by Host/Harness/cwd, bounded failure/cancel/refresh semantics; ordinary prompts do not wait on catalogs. Native metadata capabilities and collisions explicit. Unknown command, pending live catalog and cancellation are fail-closed; no silent prompt fallback for failed commands. Chips preserve text/arguments/attachments and use existing delegation admission, not a parallel coordinator. Multiple chips, whitespace, keyboard, reconnect, steer/cancel are covered. Favorites use Harness plus full Model ref identity. CI retains platform evidence, documents coverage ownership and unrun remote timing.

Use targeted Vitest, changed-module build/typecheck/lint, Chrome headless interaction/render checks. No actual Desktop restart or real provider traffic for fixture acceptance. Record source hashes, review closure, exact checks and native/remote limitations. Local batch commits after verified completion; clean worktree at end.

## Local commits

- `15061a95` — U31 CI dependency cache, PR cancellation and platform test gates; Windows failure propagation repair included.
- `b585c672` — U23 model favorite persistence, ordering/search, stale removal and narrow picker verification.
- `b66440f6` — U19 live catalog contract and U20 scoped mention codec, including code-example preservation.
- `ca8e88df` — U19 Pi/OpenCode native metadata, execution and cancellation.
- `a7d7a755` — U19 Host catalog isolation/admission and U20 delegation/command routing.
- `da72e619` — U20 Composer menu, Desktop cwd handoff and U23 active catalog/layout.
- Documentation closes R5 after review and validation.
