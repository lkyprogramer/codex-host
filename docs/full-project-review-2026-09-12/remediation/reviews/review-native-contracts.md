# Native / contracts independent review

## Binding and reviewed scope

- Repository: `/Users/luo/Documents/github/codex-host`
- Branch: `codex/full-review-remediation-20260912`
- Requested base and current committed `HEAD`: `38964658185bd090b4044f0cc9f5b575d8284b87`
- Review target: the current uncommitted worktree diff from that base.
- Rules/specification read: repository `AGENTS.md`; `docs/full-project-review-2026-09-12/README.md` F25-F29, A03, A06, A07; owner note `/tmp/codexhost-remediation-20260912/native.md`.
- Production scope reviewed: all changed `crates/` files; `packages/update-manager`; Host `remote-host-cli.ts`, `remote-host-lifecycle.ts`, `update-coordinator.ts`, `harness-session-validation.ts`, `harness-plugin-loader.ts`; shared Harness model/session contracts and validator; plugin build/release metadata; `tools/check-boundaries.*`.
- DeepSeek Adapter implementation was owned/reviewed by another agent and is not claimed as independently reviewed here. The public Conformance runner and CodeBuddy fixture driver were added to this review in a later explicit pass; its findings and closure are recorded below.

## Final conclusion

No remaining P1/P2 blocker was found in this review scope after remediation. Three concrete defects found during review were repaired and rechecked:

1. F29 rollback could accept a stale failed-generation descriptor as evidence that the previous Broker generation had recovered.
2. F27 `remote uninstall` could not stop a verified running listener when installation inspection returned `degraded`.
3. A03 invalid Session cleanup could wait forever on `close()`, preventing the stable `protocolError` and Host provisional cleanup.

A later low-severity duplicate `cleanupFailed` diagnostic introduced by the A03 deadline fix was also removed. The current helper handles immediate rejection and timeout followed by late rejection once.

## Confirmed behavior and fixes

### F25: update state directory

TS now derives the default update state directory from the validated runtime descriptor directory, matching the Launcher `descriptor.parent()/updates` calculation. The Linux fixture separates HOME and XDG runtime roots and checks the exact state path. No Linux Launcher-to-Host-to-Updater runtime was started.

### F26: Unix signal exit transparency

The Shim maps signal termination to `128 + signal` through `proxy_exit_code`. This is the explicit fallback allowed by F26 when re-raising after cleanup is not used. The fixture terminates itself with actual Unix signals rather than returning a synthetic numeric code. HUP/INT/TERM coverage and the focused signal convention test passed. No shell/TTY Ctrl-C or escaped-descendant live smoke was performed.

### F27: degraded Remote Host uninstall

Initial remediation made `remote uninstall` inspect the socket, stop only `running/codexhost`, wait for socket closure through the existing lifecycle path, and refuse stock/unknown ownership before deleting installation files.

Independent review found that `stopRemoteHost()` still called the strict `installedManifest()` helper, so a running, protocol-verified listener with a degraded profile or installation could never be stopped or uninstalled. The fix added `installedManifestForStop()`:

- `startRemoteHost()` still rejects degraded installation state before probing or launching.
- `stopRemoteHost()` accepts ready or degraded manifests, but retains the protocol probe, managed terminator identity verification, and socket-disappearance readback.
- The CLI fixture uses real installation/profile files and verifies stop-before-uninstall behavior; lifecycle tests separately verify degraded stop and strict degraded start.

The focused Host test group containing CLI/lifecycle coverage passed. No actual detached SSH listener or Unix socket process was started.

### F28: artifact deadline and cleanup

The default downloader accepts an AbortSignal and passes it to `fetch`; manager-level total and idle timers abort the download, refresh idle time on progress, delete the partial file, write terminal failed status, and allow the coordinator to release the operation lock. Header/body hangs were not exercised against a real network server. A custom injected downloader that ignores its AbortSignal remains a cooperative-cancellation limitation; it is not the production default path.

### F29: previous Broker generation recovery

The implementation preserves a verified current-user-owned, non-symlink, mode-0600 previous plist and its loaded/running state before replacing a loaded Broker. On candidate failure it stops the candidate if necessary, restores the old plist atomically, bootstraps it, and restarts it when the previous state was running.

Independent review found that the first rollback implementation only required `launchctl` state `running` plus any non-empty descriptor. A stale descriptor left by the failed candidate could therefore make rollback report success before the restored generation had published a usable endpoint.

The current code captures the failed generation descriptor after candidate bootout and reuses `wait_for_ready`; rollback now requires a non-empty descriptor with a different fingerprint while the service is running. The focused test rejects stale, missing, and not-loaded observations and accepts only a fresh fingerprint. No real `launchctl`, Aqua session, Broker endpoint, or injected upgrade failure was run.

### A03: Session validation and rejected cleanup

Successful plugin Session results are checked for Harness identity, capabilities, initial state/native identity, usage, async outputs, required methods, and supported optional controls before Host use. Rejected Sessions are closed through the shared Host helper.

Independent review reproduced a malformed Session whose `close()` never settled. The Loader awaited that cleanup indefinitely, so it never returned `protocolError` and Host provisional cleanup could not proceed. The shared helper now applies a default one-second rejected-close deadline, reports cleanup failure, and returns the validation result after the deadline. Loader and other Host open paths share the same behavior.

The first deadline implementation could emit `cleanupFailed` twice for an immediate rejection or for a rejection arriving after timeout. The redundant late `catch` callback was removed. Current tests cover never-settling close, immediate rejection, and timeout followed by late rejection, each with one diagnostic.

`turnControl` is intentionally additive optional metadata. Existing plugin Sessions with legacy `steering`/`workMode` controls remain valid when `turnControl` is absent. Returning the original Session also intentionally preserves method receivers and existing dynamic state semantics; no normal built-in call path was found that made getter mutability a defect.

### A06/A07: per-plugin distribution metadata and boundaries

The release configuration now owns a separate third-party runtime-package allowlist for each of the ten preinstalled plugins. Each generated plugin directory includes `build-receipt.json` with plugin/API versions, bundle SHA-256, observed bundled package versions, and explicit unknown native version. Release payload and npm path lists include that receipt.

A temporary all-plugin build confirmed that each current allowlist exactly matched its Bundle inputs:

- `pi`: `diff`, `zod`
- `claude-code`: `@anthropic-ai/claude-agent-sdk`, `zod`
- `deepseek-harness`: `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`, `diff`, `ws`, `zod`
- `opencode`: `@opencode-ai/sdk`, `zod`
- `grok`: `@agentclientprotocol/sdk`, `diff`, `zod`
- `omp`: `diff`, `zod`
- `antigravity`: `zod`
- `kiro-cli`, `codebuddy`, `cursor-cli`: `@agentclientprotocol/sdk`, `diff`, `zod`

Boundary checks now cover production dependency declarations, TS project references, and private cross-package path aliases in addition to source imports. The focused repository boundary command passed.

### Usage validator baseline defect

While the shared Session validator was integrated, `outputTokensPerSecond` exposed an existing validator defect: it was grouped with integer token counters and rejected legitimate fractional rates. It was moved to the finite non-negative numeric branch, and `12.5` is covered by a regression test.

## Added A03/A05 Conformance driver review

The later review covered `packages/harness-adapter/src/conformance.ts`, `conformance-output.ts`, `conformance-receipt.ts`, the public `@codexhost/harness-adapter/conformance` export, and `packages/adapters/codebuddy/test/conformance.test.ts`. Five confirmed evidence-integrity gaps were found and repaired:

1. The initial receipt could report top-level `passed` while an advertised capability was `notCovered`, and could also pass with native cleanup readback absent. The public status now includes `incomplete`; advertised `notCovered`, cleanup readback `notCovered`, or unknown residue makes the receipt incomplete. Unadvertised capabilities remain honest `skipped` values and do not prevent `passed`.
2. `timeoutMs` initially bounded only output polling. Adapter factory, inspect, open, execute, snapshots, capability probes, Session/Adapter close, and cleanup readback could wait forever. They now share a bounded operation wrapper. A factory or open that resolves after timeout triggers best-effort closure of the late Adapter/Session, while known resources continue through bounded cleanup and a failed receipt.
3. The initial output collector accepted the first matching `turn.completed` and never rejected duplicates. The extracted internal `conformance-output.ts` now counts terminals per Host Turn, rejects duplicate terminal events, rejects output after close was requested, and rechecks collector health when output ends.
4. Initial identity checks did not bind lazy first-turn, cancellation, and resumed follow-up Native Turn refs to the Adapter and expected Native Session. The driver now checks Harness ID, Native Session ID, and format version at all three boundaries and preserves exact snapshot readback for the first Turn.
5. The isolated Session had no output collector or receipt field, so its output stream could remain open or emit after close while cleanup passed. `isolatedOutput` is now tracked, awaited, aggregated, and able to fail cleanup.

During closure review, the late-value callback still had a synchronous-throw hole: `onLateValue(value)` and late `close()` were evaluated before entering a rejecting Promise chain. A JavaScript Adapter whose `close()` threw synchronously could therefore create an unhandled rejection after the receipt had returned. Invocation is now deferred through `Promise.resolve().then(...)` and caught. Factory-timeout and open-timeout fixtures use synchronously throwing late close implementations and assert that no `unhandledRejection` occurs.

The new all-false capability fixture briefly used the invalid value `permissionModeScope: "duringSession"`, which could produce a passed receipt carrying data outside the public `"live" | "atCreate"` schema. It was corrected to `"live"` without expanding driver responsibility.

The package has a public `./conformance` export, and `conformance.ts` re-exports receipt serialization and public receipt/plan types. No export gap remained after review.

### Final isolated-activation single-consumer closure

The full Adapter matrix exposed a follow-up regression from adding the isolated output collector: the Antigravity, Claude Code, and Pi `activateIsolated` callbacks still iterated `session.outputs` themselves, creating a second consumer beside the driver-owned collector. The public callback contract now receives:

- `session: Omit<HarnessSession, "outputs">`, allowing it to start the minimal native Turn without exposing an output iterator in the TypeScript contract;
- a `ConformanceOutputObserver` whose only operation is `waitForTerminal(turnId)` on the driver-owned collector.

All three callbacks now only call `session.execute(turn.start)` and await `observer.waitForTerminal`; none iterates outputs directly. The driver creates the isolated collector before activation and binds the observer to that exact collector and configured timeout. CodeBuddy adds a regression wrapper that counts `Symbol.asyncIterator` acquisition and proves the isolated stream has exactly one consumer. `docs/adapter-conformance.md` describes the same ownership rule and example.

Independent source review found the new interface, the three consumers, public type exports, test, and documentation consistent. No residual double-consumption finding remained. The owner reported the ten-Adapter Conformance matrix at 27 passed; the `432` count was a test filter count rather than executed tests. Lint and tests no-emit checks were also reported green; this reviewer did not rerun the matrix per instruction.

## Native listener timing remediation addendum

The full Rust run exposed a macOS Remote listener timing failure. Profiling attributed the delay to `lsof` scanning unrelated file classes during socket-owner lookup; process snapshots and identity matching were not the bottleneck. The Native owner added only `lsof -U`.

Independent security review confirmed that `-a` still intersects Unix-socket selection with `-u <current uid>` and the exact socket path. The returned PIDs still pass through ancestor, listener role, executable/Host Runtime path, and process start-identity checks before reuse or termination. The optimization therefore narrows discovery work without relaxing ownership or PID-reuse protection.

## Validation actually run by this reviewer

- `node tools/check-boundaries.mjs`: passed.
- Focused Vitest group for Session validation/Loader, update manager/distribution, Remote CLI/coordinator, boundary checks, and plugin dependencies: 8 files passed; 102 passed, 1 Windows-only skipped.
- `tests/release/host-bundle.test.mjs`: 9 passed, including relocated release bundles.
- Temporary build of all ten preinstalled plugins: completed; Bundle dependency sets matched the per-plugin receipt/allowlist data listed above.
- `packages/harness-adapter/test/usage.test.ts`: 26 passed.
- `cargo test --locked -p codexhost-shim --features test-utils preserves_official_cli_shutdown_signal_exit_conventions`: 1 passed.
- Focused platform tests for previous plist preservation and combined primary/rollback error reporting: 2 passed.
- `cargo test --locked -p codexhost-platform rollback_readiness`: 1 passed after the fresh-descriptor repair.
- Final focused Host closure group (`remote-host-cli`, `remote-host-lifecycle`, `harness-session-validation`, `harness-plugin-loader`) before the duplicate-diagnostic micro-fix: 4 files, 44 passed.
- Final helper/Loader tests after the duplicate-diagnostic micro-fix were reported by root as 29/29 passed; this reviewer inspected the final helper and test code but, per instruction, did not rerun them.
- Before Conformance remediation, this reviewer ran the CodeBuddy Conformance fixture alone: 4 passed; that run confirmed the then-current false-positive expectation (`passed` with advertised `subagents: notCovered`).
- After remediation, the Conformance owner ran the public built package against CodeBuddy and Cursor fixtures: 18 passed. The owner also reported the Harness Adapter package typecheck passed. This reviewer inspected the stable source/tests and did not rebuild the dist artifact independently.
- Native owner validation for the `lsof -U` change: the previously failing listener reuse fixture passed in 1.42s; focused `remote_lifecycle` tests passed 4/4, including mismatched-runtime refusal. Root later reported the final Native workspace at 172 passed with Clippy and rustfmt checks passing; those aggregate commands were not rerun by this reviewer.
- Scoped `git diff --check`: passed.

## Not covered by this reviewer

- Full repository build, full TypeScript suite, or complete Rust workspace test suite executed by this reviewer.
- Real Linux update/restart flow, GitHub stalled-response smoke, Windows installer flow, or macOS DMG installation.
- Real SSH Remote Host process/socket lifecycle.
- Real `launchctl`/Aqua Broker upgrade and rollback failure injection.
- Desktop launch, Renderer behavior, live Harness/native model calls, deployment, publication, commit, or push.
- The full DeepSeek implementation owned by the other review track.

Root separately reported that final typecheck passed. The earlier full-workspace Rust timing failure was traced to the macOS `lsof` discovery cost and closed by the Native owner as described above.
