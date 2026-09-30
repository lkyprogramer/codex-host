# R5 implementation and acceptance

Worktree: `/Users/luo/Documents/github/codex-host-r1`; branch: `codex/upstream-r1`; baseline: `ae4bcc333b4518f86b61f04a09147c092b3da13a`.

Scope: upstream comparison U19, U20, U23 and U31. No new Harness, history import, CodeBuddy changes, account/quota changes, Desktop restart, push, PR or deployment.

## Implemented contracts

- U19: command metadata carries explicit `static` / `live` provenance and command / skill kind. Adapter inspection accepts cwd and cancellation, owns native discovery and closes temporary resources. Pi uses `get_commands` with `--no-session`; OpenCode uses native `/command` metadata and `session.command` execution. Host and Renderer do not read or interpret native skill files.
- Workspace catalog instances belong to a Host, key entries by Harness and normalized cwd, and cap the cache at 64 entries with a 30-second TTL and 10-second query deadline. Shared requests retain independent waiters; refresh, final-waiter cancellation and close invalidate late results. Live metadata always uses the Adapter’s short-lived inspection path, even when a Session is loaded: public Session command reads share its operation queue and could otherwise delay prompt or cancel. Static metadata and the Host/Harness/cwd cache are reused.
- Builtin IDs and invocations win collisions. OpenCode same-name metadata from conflicting native sources is excluded because the execution API cannot select its source. Dynamic admission requires native metadata; an unknown or failed command never becomes an ordinary prompt.
- U20: one `#` menu exposes delegation targets, commands and skills. Native mention chips and their Markdown carriers use the same Host contract. Command carriers include Harness identity. Multiple command chips and mixed command/delegation chips are rejected while preserving the draft. Arguments retain tabs, indentation and trailing whitespace. Delegation selections use the existing skill/coordinator flow.
- U23: selected Harness inspection is scheduled before other catalog work. Model favorites persist by Harness plus full opaque Model ref, remain searchable and removable after a model disappears, and fit narrow Composer controls.
- U31: Linux x64 retains the full `check`; all four platforms retain complete TypeScript/Rust behavioral tests and anchor setup. Static checks run once, Rust dependency cache is pinned, and only superseded PR runs are cancelled. Independent TypeScript/Rust steps preserve Windows failures. See [coverage ownership](ci-coverage.md).

## Maintenance and regression entry points

| Slice | Implementation owner | Focused regression entry |
| --- | --- | --- |
| U19 metadata and native execution | `shared-contracts/harness-commands`, `harness-adapter/text-session`, Pi/OpenCode Adapters | Pi/OpenCode Adapter and RPC/transport tests |
| U19 cache and admission | `host-runtime/workspace-command-catalog`, `app-server-host` | `workspace-command-catalog.test.ts`, commands/interrupt cases in `app-server-host.test.ts` |
| U20 carriers and delegation | `shared-contracts/delegation-mention`, Host rewrite/routing helpers | `delegation-mention.test.ts`, `composer-command-routing.test.ts`, Host official/external/steer tests |
| U20 Composer and cwd | Renderer mention/controller/binding modules, Desktop prewarm runtime | `composer-hash-menu.spec.ts`, `renderer-binding-startup.spec.ts`, serialized prewarm test |
| U23 scheduling and favorites | Renderer binding and model picker/favorites | Host catalog scheduling unit test and `renderer-model-picker.spec.ts` |
| U31 CI | `.github/workflows/ci.yml` | Repository automation workflow tests and [platform inventory](ci-coverage.md) |

## Verification boundaries

Exact validation results, code tree fingerprint and independent Astra review closure are recorded in [REVIEW.md](REVIEW.md).

OpenCode metadata-only smoke used the installed binary and returned 42 live entries (2 commands, 40 skills), then closed its managed server. It created no Session and sent no provider prompt. Pi was run under Node v22.19.0: the CLI returned 49 raw entries; the real Pi Adapter returned 41 admitted live entries and closed its temporary RPC transport. Neither check sent a provider prompt. Chrome tests exercise DOM, keyboard, routing and persistence fixtures. They do not prove compatibility with the running Desktop's private Composer bindings or its actual visual styling. Desktop restart and provider-backed end-to-end execution were not performed. Remote Actions cache timing, Windows execution, PR cancellation and cross-platform CI remain unrun locally.

## Rollback

Revert the R5 commits in reverse dependency order. No durable thread schema migration is introduced. Existing adapters without live catalog support retain static metadata behavior. Model favorite storage is an optional Renderer preference; leaving stored favorites after rollback does not alter Thread state.

## Source attribution

`renderer-delegation-mention.ts` adapts the upstream file at `8de2be76`; `renderer-native-composer-controller.ts` and `renderer-harness-command-control.ts` adapt their upstream files at `72f5f235`. Source repository, paths and revisions are recorded in their headers. These revisions follow upstream's LGPL change; the current repository LICENSE is not a claim that all latest upstream code is MIT. This local implementation includes no release or overall licensing-compliance determination.

Native exclusion lists live in `packages/adapters/pi/src/pi-native-commands.ts` and `packages/adapters/opencode/src/native-commands.ts`. They exclude lifecycle, configuration and unmanaged background commands from the corresponding native command sources; skills are not categorically excluded. A source collision that cannot be targeted by the native API is rejected before filtering.
