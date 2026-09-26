# R2 execution

Worktree: /Users/luo/Documents/github/codex-host-r1; branch codex/upstream-r1; HEAD af255feb.
Preserve uncommitted R1 changes; r1-baseline.json records incoming file hashes.
Scope: U05/U06/U08/U12/U16/U17/U18. User explicitly excluded U15/CodeBuddy (not installed locally). No accounts/quotas/import/new Harness work. No commits, push, installs or Desktop launch.
Ownership: Host fork/state U05 then U12 one owner; mapping lock U06; attachment U08; OMP U16; OpenCode U18; root Pi cancellation U17 and overall integration. Separate final read-only review after edits.
Verification: focused tests, TypeScript build/typecheck, lint/boundaries, Rust attachment tests, preservation of R1 bytes unless a documented shared-file integration is needed. Native/provider/SSH/platform checks reported separately.
Status: all seven in-scope items implemented and locally validated. The original U12 finding and three repair-round P2 findings are closed by verified native Astra/high re-review. Final Host regression: 214 passed; typecheck/lint/diff checks passed. U15 explicitly excluded. See REPAIR.md and RESULT.md for evidence and unrun native/platform boundaries.
