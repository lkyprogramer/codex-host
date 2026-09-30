# Integration result

Code and candidate package: **PASS**. Desktop installation/cutover: **not executed** pending a maintenance window that permits ending the current running Desktop chat.

## Candidate and preserved sources

- Worktree: `/Users/luo/Documents/github/codex-host-merge-anchor`; branch: `codex/merge-upstream-anchor`.
- Final code/test commit: `36bf47bc555b8ae09f49d247728ec0b920c2c004`; tree: `8cba8d5d48f6a020b4d06444289420c687d21e75`.
- Production repair commit reviewed by both independent reviewers: `dfdcdb79593451dba644e8dcdb890ee8406d6854`; tree: `d896bb651d4ef747f76db1e4b1a38e0ed93e891b`. The subsequent commit changes only the CodeBuddy exit-event test fixture; Core independently reviewed that addition.
- Local commits: `5bd5ec76` preserves the eight pending tracked files; `640d804a` merges the frozen upstream branch and semantic adaptations; `dfdcdb79` closes review findings; `36bf47bc` repairs the synthetic exit fixture.
- Original `feat/process-anchor` remains at `6a1d26cdea98c305d6f8ab8f29a5192a397df00c`. All eight pending-file SHA256 values still match [baseline.json](baseline.json).
- Original `codex/upstream-r1` remains at `d71ed935d87e085b0c9deb54382c76e9b3277729` with a clean worktree. No push, PR, release publication or branch replacement was performed.

## Implemented integration

- Retained API v2, SessionKernel and owned-process lifecycle semantics while merging R1-R5 and Cursor U28.
- Consolidated Pi/OMP native patch decoding and history file-change hooks into pi-family; retained Pi's native-evidence rule, OMP's existing fallback rule, and their distinct native protocols.
- Integrated OpenCode dynamic command queries with SessionKernel busy admission and late-close rejection; integrated Cursor's fork lock with kernel state.
- Preserved installed plugin dynamic command discovery, private receivers, Permission Mode scope and API v1 owned-job compatibility before Session validation.
- Replaced stale-Snapshot repository retries with a single CAS. Runtime captures the record before reading native history and re-reads both after a revision conflict. Unchanged mapping lists also validate the revision without writing. Native checkpoint revocation remains supported.
- Persisted native command Turn identity when the completion supplies `nativeTurnRef`; local ephemeral commands remain ephemeral.
- Routed command, Model, Thinking and Permission Mode mutations through each Composer's Host client. Stale responses cannot affect another Host, Thread, client or request generation. A replaced client triggers a fresh ownership read. Local Fork uses the local client.
- Updated the relocated Host Bundle dependency assertion for protocol-core's existing `diff` dependency and removed an unused merge-test import. No CodeBuddy production behavior was changed.

## Verification

Node: `v22.19.0`. Commands below were run from this worktree with that version first in PATH. Process checks use the task-private ledger `/tmp/codexhost-merge-anchor-20260930/ledger` with mode `0700`.

| Check                                                                                  | Observed result                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                    | PASS, including the final test-only change                                                                                                                                            |
| `npm run lint`                                                                         | PASS after removing the unused import; final test-only file also passed ESLint                                                                                                        |
| Prettier check over all added/modified paths since `af255feb`, including pending files | PASS; `--ignore-unknown` for unsupported artifact formats                                                                                                                             |
| `cargo fmt --all --check`, `git diff --check`                                          | PASS                                                                                                                                                                                  |
| `npm run build:typescript`, `npm run build:renderer`, `npm run build:rust`             | PASS; independent plugin bundles rebuilt                                                                                                                                              |
| Initial adapter/kernel/shared-contract group                                           | 104 files passed, 3 skipped; 1,367 tests passed, 5 skipped                                                                                                                            |
| Host/Mapping/Protocol/Discovery group                                                  | 78 files passed, 2 skipped; 924 tests passed, 4 skipped                                                                                                                               |
| Desktop/Renderer/Update/Release group                                                  | 75 files passed and 664 tests passed, with 2 skipped; one Bundle dependency assertion failed, was repaired, and its whole file passed 9/9 on re-run                                   |
| Final Renderer regression after the Host-client guards                                 | 45 files / 457 tests passed                                                                                                                                                           |
| Explicit candidate-Anchor combined TS run                                              | 224 files / 3,345 tests passed, 5 files / 9 tests skipped; one synthetic CodeBuddy fixture failed and was repaired as described below                                                 |
| Failed fixture and direct process regression re-run with candidate Anchor              | `exit-event.test.ts`, `acp-client.test.ts`, `owned-process.test.ts`: 3 files / 33 tests passed                                                                                        |
| Browser fixtures in local Chrome                                                       | 7 spec files / 37 tests passed                                                                                                                                                        |
| Rust Anchor                                                                            | 16 unit + 16 integration tests passed                                                                                                                                                 |
| Rust Launcher and Platform                                                             | Launcher 50 unit + 4 CLI tests; Platform 53 tests passed                                                                                                                              |
| Rust Shim                                                                              | 26 unit tests passed. Initial parallel proxy run had a 2-second timeout in the legacy-owner fixture; exact case re-run passed, then all 45 proxy tests passed with `--test-threads=1` |
| Rust Updater                                                                           | 10 passed; 1 ignored because it requires a volume without `RENAME_SWAP`                                                                                                               |

The final combined TS command was:

```sh
env PATH=/Users/luo/.nvm/versions/node/v22.19.0/bin:$PATH \
  CODEXHOST_PROCESS_ANCHOR_PATH="$PWD/target/debug/codexhost-anchor" \
  CODEXHOST_PROCESS_LEDGER_DIR=/tmp/codexhost-merge-anchor-20260930/ledger \
  CODEXHOST_RUN_REAL_CLAUDE_TESTS=0 CODEXHOST_RUN_REAL_OPENCODE_TESTS=0 \
  npx vitest run --config tests/vitest.config.js \
  packages/adapters packages/harness-adapter/test packages/shared-contracts/test \
  packages/host-runtime/test packages/mapping-store/test packages/protocol-core/test \
  packages/harness-discovery/test
```

The CodeBuddy fixture originally mocked `node:child_process` and supplied a fake child without a PID or Anchor control pipe. Its owned process tree was therefore unavailable. The repair mocks the client's direct `spawnOwnedProcess` dependency, retains every exit/buffered-output/request/fault assertion, and adds a once-only tree-close assertion. Actual ACP and Anchor behavior remain covered by the direct process tests; the synthetic fixture is not native evidence. The passing files from the combined run were not repeated after this test-only change.

Early process checks inherited the installed Desktop's Anchor path despite constructing a candidate-local environment for individual Harnesses. They are not counted as candidate-Anchor evidence. The final combined TS run specifies the Anchor in the **Host process environment**. Native smoke was then repeated with the release Anchor. An earlier ledger with permissive permissions was corrected to `0700` before the final checks. No process fallback is claimed as native supervision proof.

Browser execution used the repository Playwright configuration with only `launchOptions.executablePath` overridden to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; the cached Playwright headless binary was absent. The first five specs passed 30 tests; `renderer-settings-resources.spec.ts` and `renderer-settings-update.spec.ts` passed another 7. [Screenshots](screenshots/) show actual Chrome fixture rendering, not the running Desktop. Generated screenshots were copied here; the historical R4 screenshot files were restored to their original bytes.

## Native evidence

The final native commands used `CODEXHOST_PROCESS_ANCHOR_PATH=target/aarch64-apple-darwin/release/codexhost-anchor` in the Node Host environment. Both metadata inspections and Cursor derivation closed their owned resources.

- Pi `0.99.1`: native `get_commands` through an RPC transport started with `--no-session`; 28 admitted live entries; the private Session directory remained absent/empty. No provider prompt was sent. The added private workspace skill was not discovered by this installed CLI; no claim is made for that fixture's native cwd discovery. See [catalog receipt](catalog-native-receipt.json).
- OpenCode `1.18.30`: 4 live entries, including the configured native smoke command; managed server closed; no Session-create or provider-prompt API was invoked. See the same catalog receipt.
- Cursor `2026.09.10-fd3934a`: source history had two Turns; fork at the verified first checkpoint and last-Turn revise each retained one Turn with distinct native identity. A forked Session completed one provider-backed continuation with the exact marker. `store.db` and `meta.json` SHA256 values were unchanged in the source. See [Cursor receipt](cursor-native-receipt.json).
- Cursor's first run used the installed Anchor and sent three small Turns. The candidate-release-Anchor re-run reused that task-created source Session and sent one continuation Turn. It did not create another seed history. Both source and derived native histories were retained.

The reproductions are [catalog-smoke.mjs](catalog-smoke.mjs) and [cursor-derivation-smoke.mjs](cursor-derivation-smoke.mjs). They use dedicated task directories and reference this worktree's built modules. The latter's `--reuse-source` option consumes the task's prior receipt.

## Review

Both independent reviewers were verified as `gpt-6-astra / high` from their actual turn contexts.

- Core: session `01a0f015-050c-7f93-afad-47854d6ef99d`; PASS at `dfdcdb79`, then supplementary PASS at `36bf47bc`. Four confirmed findings were repaired and rechecked.
- Native/UI/release: session `01a0f015-3f10-7393-a423-e31b5a62e085`; PASS at `dfdcdb79`. The later commit changes only the Core-reviewed test fixture, with no production diff.
- Review scope includes both branch histories since the shared base, the eight preserved pending files, and integration repairs. Reviewers distinguish their read-only/static evidence from the root agent's test and runtime executions.

## Package, cutover and rollback

`npm run release:npm -- --target macos-arm64 --version 0.7.0-local.14 --pack` and `npm run release:npm:meta -- --version 0.7.0-local.14 --pack` passed. The platform package contains the coherent Host, installed plugins, Renderer and Rust release binaries. Exact artifact bytes and SHA256 values are recorded in [package-receipt.json](package-receipt.json).

The installed runtime still uses the Node `v22.16.0` global package. Its package and meta package, plus a live Mapping Store snapshot, were copied under the private `/tmp/codexhost-merge-anchor-20260930/rollback` directory. Content manifests are recorded there, and executable modes are preserved. The Mapping Store copy was made while Desktop was live; it must be recaptured after drain before it is treated as a cutover snapshot. Credentials and runtime tokens are not included in repository evidence.

Read-only preflight observed the current chat as `running`. The installed Host does not expose `codexhost/resources/list`, so no complete old-runtime resource-quiescence claim is made. No idle Thread was cancelled and no Desktop process was stopped. The maintenance-window question is the remaining execution input. See [CUTOVER.md](CUTOVER.md) for the prepared sequence.

## Unrun boundaries

- Real Desktop restart, candidate reinjection, existing Desktop Thread restoration and post-cutover UI acceptance.
- Windows/Linux native runtime and installation; cross-platform CI; macOS updater installation against a real application; the updater fallback-volume case.
- Real Claude/OpenCode provider suites that the targeted TS groups skipped. OpenCode metadata smoke is not provider execution.
- Full repository `npm test`, `check:rust`/Clippy and whole-platform packaging. No claim is made for these layers.
- Global PATH/nvm-default changes, push, PR, publication, account/quota work, CodeBuddy production optimization and other-Harness history import.
