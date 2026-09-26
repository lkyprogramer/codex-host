# R4 conditional scope: U32 and U33

Baseline: `1127cbc1c4d17ac2f6d1ba20b77236f6ca9b98c2` in `codex-host-r1`.
Reference commits: upstream `8d5e43bd` (U32) and `8bb27d6a` (U33).

## U32: implement official section ordering

The installed Desktop at `/Applications/ChatGPT.app` is version
`26.917.71314`; its bundled CLI reports `codex-cli 0.155.0-alpha.16.4`.
Read-only inspection of its `Contents/Resources/app.asar` found a
`listHostSectionThreadIds` path that paginates `adapter.listThreads` with
`sectionId`, `sortKey: "section_position"`, `useStateDbOnly: true`, and the
returned native `nextCursor`. A compatibility probe also calls `listThreads`
with `sectionId` and the same sort key. These are installed-code call sites;
no live request was captured. The fork previously rejected this sort key
while decoding `thread/list`, so the installed call path could receive
`-32602` before reaching the official CLI.

The R4 change accepts `section_position` only for an official-only list.
It forwards the original parameters and native cursor through the existing
AppServerHost official forwarding path. Host cursors are rejected for this
sort key. The three timestamp sort keys retain External Thread and
multi-Account aggregation. The multi-Account merger also rejects this sort
key if directly called. This does not alter custom delegation-list pagination.

## U33: defer the macOS sandbox exception

The current Shim requires either `CODEXHOST_STOCK_CODEX_PATH` or a
`CODEX_CLI_PATH` that identifies the running Shim before it discovers the
Desktop-managed official CLI. In an isolated process with a temporary HOME,
only `PATH`, and top-level arguments
`sandbox -c 'shell_environment_policy.inherit="all"' -- /usr/bin/true`, it
exited 1 with empty stdout and
`codexhost shim: CODEXHOST_STOCK_CODEX_PATH is required`.
The existing `rejects_missing_stock_cli_without_a_cli_override` proxy test
passed. These results reproduce the missing-override condition, not a real
Desktop `node_repl` reentry.

The installed Desktop code passes `CODEX_CLI_PATH` into the initial
`node_repl` MCP server environment. Whether its sandbox child clears both
CLI overrides remains unverified. U33 therefore stays deferred; the current
fail-closed behavior remains in place. A future implementation needs a
non-production isolated `node_repl` child fixture showing the actual cleared
environment and command, then macOS-only success and ordinary command,
non-macOS, self-target, and invalid-path rejection tests. No Desktop restart,
production hook, profile read, or live `node_repl` run was performed here.

## Local verification

- `cargo test --locked -p codexhost-shim --features test-utils --test proxy rejects_missing_stock_cli_without_a_cli_override -- --exact`: 1 passed.
- `vitest run --config tests/vitest.config.js packages/protocol-core/test/thread-management.test.ts packages/host-runtime/test/thread-list-aggregator.test.ts packages/host-runtime/test/multi-account-thread-list.test.ts`: 3 files, 23 tests passed (Node 22.22.0, `NODE_USE_ENV_PROXY` unset).
- `prettier --check` on the U32 source, tests, and this document; `eslint` on the U32 TypeScript files; `git diff --check`: passed.
- `tsc -b packages/protocol-core packages/host-runtime --pretty false`: U32 type errors resolved, but the combined build was blocked by a concurrent U22 `external-thread-runtime.ts` `harnessId` branded-type error. That initial integration error was later fixed by root; final `npm run build:typescript` and `npm run typecheck` passed (see RESULT.md).

The official `thread/list` forwarding behavior was checked through the
existing AppServerHost dispatch path and decoder tests. A live Desktop request,
native CLI response, and UI pagination were not run.
