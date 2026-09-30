# Prepared Desktop cutover

Status: package and rollback copies ready; Desktop restart is not executed. On 2026-09-30 the user chose candidate delivery in this round and a separate idle maintenance window for switching. The current running chat must finish before that window. Existing unrelated work must not be cancelled to manufacture quiescence.

## Preflight

1. Confirm the selected maintenance window. Inspect running Threads and owned processes; finish active work before installing. The old Host lacks the new resource inventory endpoint, so the current preflight is not complete quiescence proof.
2. Recheck both frozen source HEADs and all eight pending-file hashes in `baseline.json`. Recheck integration code commit `36bf47bc` and the artifact SHA256 values in `package-receipt.json`. Any source drift requires reconciliation before proceeding.
3. Recapture the Mapping Store after drain. Retain `/tmp/codexhost-merge-anchor-20260930/rollback` and the native Session histories. The current live snapshot is a recovery aid, not an atomic offline backup.

## Switch

The existing repository installer performs local packaging/installation, stops Desktop and its previous codexhost runtime, then launches the installed coherent payload. Its process-stopping behavior is intentional and must not be invoked during candidate tests.

```sh
cd /Users/luo/Documents/github/codex-host-merge-anchor
env PATH=/Users/luo/.nvm/versions/node/v22.19.0/bin:$PATH \
  npm run install:local -- --no-build
```

This installs into the Node `v22.19.0` npm prefix and starts that exact installed command. The prior Node `v22.16.0` prefix remains the rollback installation. This does not change the user's default nvm version or shell PATH; future launches must select the `v22.19.0` command explicitly. It does not publish either tarball.

## Acceptance after restart

- Confirm the launcher, Shim, Host, Controller, Renderer, plugins and Anchor belong to the candidate installation. Check runtime ownership and actual process executable paths, not only the unchanged local version string.
- Confirm the Renderer binding is ready and `codexhost/resources/list` returns the candidate's resource observations.
- Restore an existing Thread and check its stable Host/native identities and persisted configuration. Check dynamic command catalog, cancel/settlement and idle release with a dedicated smoke Thread.
- Check Cursor fork/revise and one continuation without altering the source history; candidate headless proof exists but actual Desktop controls remain unverified until this step.
- Record the new runtime descriptor and payload hashes with secret fields omitted. Only then mark cutover PASS.

## Rollback

Stop the candidate cleanly and launch the retained prior installation explicitly. Restore package bytes from the private copy only if that prefix has been changed, preserving its executable permissions. Do not restore stale live PID/nonce descriptors as if they were current owners, and do not overwrite Mapping Store or native Session history to roll back code. The Mapping Store snapshot is for a diagnosed data recovery decision, not automatic code rollback.

If native close or owned-job quiescence is unknown, retain the affected native targets and staging directories, record their identity, and stop the cutover. Do not broaden cleanup to unrelated processes or data.
