# U28 Cursor native fork and revise

Branch: `codex/upstream-r1`; start commit: `54d00cad`.

## Result

The existing Cursor Adapter now derives native Sessions for `fork` and `rollbackLastTurn` on macOS/Linux where `/usr/bin/script` is present. It does not claim cross-workspace fork or Windows support. It publishes a checkpoint for a head Turn and for an earlier Turn only when the following native Turn has a verified rewind root. The Adapter rejects a stale checkpoint, busy source, different cwd, missing rewind root, or unavailable native runner before admission.

The derivation transaction copies the source SQLite database consistently into a private temporary Cursor configuration, uses Cursor's own `/fork` and `/rewind` commands through the repository's `spawnOwnedProcess` API, and checks the new native identity, exact retained history, and unchanged source. The target is adopted through the existing ACP resume path and checked again before commit. Failure, Adapter close, timeout and cancellation request owned-process shutdown; an uncommitted target is discarded only after ACP closure is confirmed. If PTY closure cannot be confirmed, the private staging directory is retained and its path is reported for recovery; if ACP closure cannot be confirmed, the derived native target is retained and its Session ID is reported. Native target files use private permissions. Cold-source forks receive the saved source model and confirm it on ACP adoption. Existing parameterized model selection, history-only replay, catalog cache, permission mode and resource suspension paths remain in their Adapter owners.

Implementation: `packages/adapters/cursor-cli/src/{fork.ts,fork-terminal.ts,fork-support.ts,adapter.ts,native-history.ts,projection.ts,models.ts,command.ts}`. The three new fork modules and two fixtures, plus the native-history rewind decoder, checkpoint projection and Adapter admission logic, were adapted from the frozen upstream tree `BytePioneer-AI/codex-host@997f62a0ede22609ed42b949957100d16043ad17`, which carries LGPLv3; file headers or localized comments record the source. The implementation was adjusted for this fork's owned-process API, capability contract, model parameters, lifecycle and private file permissions. This local work was not published and is not an overall license-compliance determination.

## Validation

- `npm run typecheck` and `npm run lint`: passed.
- Cursor Adapter's 13 Vitest files: 132 tests passed. New tests cover native head/history/rollback transaction identity, empty history, bad checkpoints, target cwd, cold-source model preservation, failed ACP adoption and cleanup, Adapter close during ACP adoption, PTY cancellation/timeout and unconfirmed cleanup, private target permissions and checkpoint projection. Host fork, rollback and checkpoint filtered tests passed (148; 178 unrelated tests skipped by the name filter). The conformance fixture reports fork/revise as `notCovered` because it does not construct the native SQLite and interactive terminal protocol; the dedicated tests own that behavior.
- Installed `cursor-agent --version`: `2026.09.10-fd3934a`; macOS `/usr/bin/script` present. Read-only sample: 8 of 15 local native Session stores were readable and exposed rewind roots.
- Real native head fork on an inactive source: independent target, exact one-Turn readback, source unchanged, target discarded. Real native revise: 11 source Turns to 10 derived Turns, exact retained prefix, source unchanged, target discarded.
- Real Cursor Adapter `open(kind=fork)` and `open(kind=rollbackLastTurn)` each produced an independent Session. ACP `readSnapshot()` read back the expected derived history (one and ten Turns respectively); sources were unchanged and the derived test targets were closed and removed.

A provider-backed follow-up Turn and Windows run were not performed. The temporary real forks did not submit a model prompt. A real follow-up would require a provider request and remains a separate acceptance check. No Desktop restart, push, PR, or release was performed.

## Review

The independent final reviewer ran as `gpt-6-sol` with `xhigh` effort (session `01a0e0be-77ea-75c3-aec5-0da14e561f2c`, verified from its turn context). It found and rechecked repairs for unconfirmed ACP/PTY cleanup, Adapter close during adoption, cold-source model inheritance, and persisted checkpoint revocation. Its final code verdict found no remaining confirmed defect. The reviewer ran `git diff --check`; the test counts above are the implementer's runs, not independent reviewer reruns. The provider-backed continuation remains outside the reviewed acceptance evidence.

## Rollback

Revert the U28 code commit to disable the capability. Existing native derived Sessions remain ordinary Cursor Sessions readable by the current reader; do not delete their stores. An older reader's resume of a produced Session is not claimed without testing that exact version.
