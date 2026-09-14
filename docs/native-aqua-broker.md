# Native Harness plugins in the macOS Aqua session

Native CLI credentials held by the login keychain may not be accessible from an
SSH audit session. A managed remote plugin can use `BrokeredHarnessAdapter` to
run its native CLI through the current user's Aqua LaunchAgent.

The broker owns exactly one installed plugin. Its authenticated owner-only socket
and descriptor are scoped to the plugin ID. Foreign Session/parent references
are rejected before opening a native Session. Sequence, generation and native
writer ownership checks remain in force across requests.

Rust manages the service lifecycle:

```sh
codexhost broker install --harness <plugin-id>
codexhost broker status --harness <plugin-id>
codexhost broker stop --harness <plugin-id>
codexhost broker uninstall --harness <plugin-id>
```

The installed candidate's launcher supplies its Node/runtime paths; explicit
`--node` and `--host-runtime` options are also supported. Without `--harness`,
the commands still select Claude Code and preserve the legacy label, paths and
wire protocol. Other plugins have distinct
`ai.bytepioneer.codexhost.<plugin-id>-broker` LaunchAgents and
`~/.codexhost/harness-broker/<plugin-id>-broker-v1.{json,sock}` resources.

The Host loads a plugin with `managedRemoteHost: true` for managed remote
execution. Its factory may select a broker client there and a native adapter for
local execution. The broker loads the same plugin with native context, avoiding
recursive broker construction. Neither the generic Host nor the broker imports
concrete adapters.

New clients may opt into forwarding the Host's scoped delegation environment:
`CODEXHOST_CLI_PATH`, `CODEXHOST_RUNTIME_ENDPOINT`, `CODEXHOST_RUNTIME_TOKEN`, and
`CODEXHOST_THREAD_ID`. HOME, PATH, loader variables and native credentials cannot
be supplied through this mechanism. Existing Claude clients retain their default
behavior. Native login files and keychain state stay in the user's home/session.

Discovery reconnects on the next explicit caller request after service startup or connection loss. A `session.faulted` event is terminal: the client emits it once, ends outputs, ignores late output, and rejects further operations on the old wrapper. An authentication-required Turn is forwarded before that Session fault.

Host retires the failed wrapper. A subsequent use of the same Thread opens a fresh resume with its confirmed Native Ref, persisted configuration and supported scoped execution intent. Recovery does not create a substitute identity or replay the interrupted Turn. Native authentication must still succeed; there is no background model polling, native fallback, or revival of a faulted wrapper.

Closing a client closes its owned Sessions and output channels. A service restart is separate from restarting Desktop or Remote Host. A failed replacement restores the verified previous plist and generation when possible; readiness requires a new descriptor fingerprint, and combined replacement/recovery failure retains both diagnostics.

Tests cover legacy compatibility, separate service/socket identities, foreign
references, scoped environment forwarding, output closure, and on-demand
discovery after a broker generation changes. Native install/stop operations must
be run only when the affected service's active work is idle.

The [Host/Broker integration regression](../packages/host-runtime/test/broker-host-fault-recovery.test.ts) uses an actual local server/client and Host with a controlled native Session. It proves one failed Turn, old-wrapper retirement, and exactly one fresh resume for the same Thread. This does not replace real Aqua, login-keychain, or launchctl upgrade/rollback acceptance. Current ownership and contracts are described in [architecture](harness-plugin-architecture.md) and [plugin runtime](harness-plugin-runtime.md).
