# Integrate upstream-r1 with process-anchor

## Goal and frozen inputs

Preserve process-anchor's API v2, owned-process, SessionKernel, pi-family, persistence and routing boundaries while admitting upstream-r1's R1-R5 and Cursor U28 behavior. Source worktrees remain untouched. `baseline.json` binds both HEADs and the eight pending tracked files copied into this integration worktree.

## Execution and ownership

1. Root: validate and commit the eight pending changes in the new worktree; merge the frozen upstream HEAD without replacing complete files blindly.
2. Pi-family worker: own Pi/OMP adapter/history conflicts and common file-change migration, with corresponding focused tests. Preserve native protocol differences and command discovery.
3. Plugin worker: own loader forwarding of dynamic command capabilities and installed API v1/v2 regressions.
4. Root: resolve remaining conflicts; adapt Cursor fork admission and OpenCode command catalog reads to SessionKernel; verify checkpoint revocation plus concurrent persistence.
5. Root: build and run affected TypeScript, native and browser groups. Use Node v22.19.0 and private runtime/ledger directories; do not launch Desktop during candidate validation.
6. Independent reviewer: reviewer.toml / gpt-6-astra high; read-only final review of both histories, pending changes and integration repairs. Root fixes every confirmed finding and records recheck evidence.
7. Cutover: freeze the final candidate, verify source drift and owned-process quiescence, preserve rollback artifacts/data, then switch the coherent Host/plugin/Renderer/Rust build. Do not delete native Session history to roll back.

## Acceptance

- No unresolved merge markers, duplicate Pi-family implementation, stale private members or lost public Adapter capabilities.
- Source pending files remain recoverable and source worktrees are unchanged.
- Typecheck, lint, focused format, complete affected builds and targeted behavioral tests pass.
- Native and browser evidence is distinguished from fixtures; unsupported platforms remain unclaimed.
- The final review has no unresolved confirmed finding. Commits and any unrun layer are recorded in RESULT.md.

## Scope

No new Harness integration, CodeBuddy optimization, account/quota work or other-Harness history import. Preserve existing upstream provenance. Push, PR and publication are outside this local integration task.
