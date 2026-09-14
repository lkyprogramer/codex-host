# Cursor ACP delegation failure — 2026-09-14

## Result

Real Cursor ACP execution now passed with the compiled candidate transport:
`grok-4.6[effort=xhigh,fast=false]` was confirmed before prompting. The agent ran
Python, wrote and reread `probe-result.json`, and returned `end_turn`. Independent
readback confirmed sum `99` and SHA256
`28dc52483d3d4834b9fc61ad60df69d364118d0eb9931a5eff3abb8804053c06`.
The owned transport closed successfully.

The functional repair skips configuration writes only when the latest native
readback already confirms the requested value. Previously even a fully selected
xhigh/non-fast session rewrote effort and fast, unnecessarily refetching Cursor's
volatile remote catalog. Missing or different values still require a native write
and confirmation; failures still retire the transport. No model downgrade,
mutation retry, proxy override, or Cursor installation patch was introduced.

Evidence: [native execution](source-live-success.jsonl),
[independent result readback](probe-readback.json).
Local npm was updated to `0.7.0-local.5`; all 62 packaged files matched the
installed files. Desktop was not restarted, so an already running Host keeps its
loaded code until its next launch. Rollback archive:
`/tmp/codexhost-npm-backup-local3-20260914/packages.tgz`.

## Installed CLI acceptance

The installed `0.7.0-local.5` CLI and Cursor plugin completed real delegation for
Thread `ccc20661-a57b-4a3f-b260-807a75ad462f`. The requested opaque model and effective
model matched exactly. Python/file readback passed with sum 99 and the SHA256 above.
The same request ID was reused for recovery, and the existing completed Thread was
returned without a second prompt. Final `thread wait` and `thread read` both returned
`completed`, with the actual final response available.

The official parent is explicitly a **fixture with no inference**; the Host Runtime,
Delegation Control, installed CLI/plugin, Cursor model, tools and native history are
real. This is not evidence that the original Desktop parent is currently owned by
an active Runtime. See [execution receipt](host-cli-local5-execution.json),
[final CLI read](host-cli-local5-final-read.json) and
[verification/cleanup](host-cli-final-verification.json).

Native connection instability remains observable: an initial completed-history read
failed, then a read-only retry succeeded. No task mutation was automatically retried.
`thread release` correctly returned `released=false, quiescence=unsupported`; this
is not a claim of native job-tree quiescence. Runtime shutdown reported no cleanup
errors, and all seven processes captured in the probe's owned tree were absent
on subsequent inspection.

A final diagnostic-only follow-up prevents the word `authenticate` in a stage label
from misclassifying socket failures as missing credentials. The final local package
includes this change; all 88 Cursor tests pass.

## Earlier failed probes (before the functional repair)

Native executable: `~/.local/share/cursor-agent/versions/2026.09.10-fd3934a/cursor-agent`.

1. Refreshed installed Host inspection succeeded and exposed the user's exact
   opaque model reference. Catalog discovery alone does not prove execution.
2. Replaying the user's exact request returned `PARENT_THREAD_AMBIGUOUS` with
   `matchingRuntimeCount: 0`. The requested parent was not owned by an active
   Runtime at that time. This is independent of the earlier Cursor error.
3. An independent native ACP probe reproduced `Internal error`, code `-32603`,
   during `authenticate`. Native `data.details` was `[aborted] socket hang up`.
   The adapter previously read only `data.message`, hiding this cause.
4. A parameterized native probe passed authentication and model selection, then
   returned a successful effort response without parameter config options.
   Setting fast subsequently failed with `No current ACP model found for config
   option: fast`. Native source fetches the model catalog for config operations;
   its catalog helper converts fetch errors into empty arrays. The observations
   are consistent with that failure path; they do not establish a specific
   network/provider root cause.
5. Native variants-mode ACP rejected alias `cursor-grok-4.6-xhigh` even though
   `cursor-agent models` listed it. The ACP directory exposed the bracket variant
   instead. Therefore switching to the alias/variants path is not a verified fix.
6. The compiled source transport opened session
   `fbe8817d-c33b-46fc-bc26-5b94e58aef4b`, then rejected configuration with
   `Cursor ACP config 'fast': Cursor did not confirm model parameter selection`.
   It closed successfully and never submitted the prompt.
7. Passing the bracket model at native process startup instead reached an ACP
   connection closure during authentication; it did not establish an alternate
   working path.

## Source repair

- History-only transports retain native authentication/load and turn identity
  validation but skip the unrelated model catalog. They reject configure, prompt
  and cancel operations. Both Session and subagent history consumers use this path.

- Skip writes only for values already confirmed by the latest native readback;
  preserve final full-model validation and failure cleanup.

- A shared Cursor diagnostic formatter preserves string `data.message` and
  `data.details`, sanitizes secrets, and does not serialize arbitrary objects.
- Open errors identify initialize/authenticate/session-new-or-load/catalog stages.
- Configuration errors retain the failed configuration key and native detail.
- No authentication, session creation, configuration, or task submission is
  automatically retried. A partially configured transport remains retired.
- Authentication-stage network failures remain protocol errors rather than
  being misclassified as missing credentials.
- Removed the incorrect comment claiming native authentication cannot launch login.

## Validation and remaining boundary

`npm run build:typescript` passed. Cursor regression tests covered native details,
redaction, stage preservation, failure cleanup, model confirmation and process
lifecycle. See the accompanying validation receipt for final counts.

The independent probes used the user's probe workspace, not another parent Thread.
The earlier failed probes never reached prompt execution. The later successful
probe created and reread `probe-result.json`; the root only read and verified it.
The original request identity was not reassigned. Existing Desktop/Host sessions,
Cursor installation and unrelated processes were not modified or terminated.

Desktop delegation still requires a live parent owned by the selected Runtime and a
healthy native ACP catalog/configuration response. Then select the exact opaque
reference from a refreshed inspection and verify task output plus terminal state.
Do not downgrade effort, assume that CLI aliases are ACP model IDs, or bypass
configuration readback to produce an apparent success.
