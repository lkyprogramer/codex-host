# Adapter conformance 收据

公共入口为 `@codexhost/harness-adapter/conformance`。`runAdapterConformance` 只消费真实 Adapter：调用方要么传入已安装插件 Loader 返回的 Adapter，要么传入该 Adapter 接到可控 native transport/journal fixture 后的实例。`FakeHarnessAdapter` 只能证明 Host 对合规事件的处理，不能成为 Adapter conformance 证据。

驱动执行的最低生命周期是：

1. `inspect`，创建 primary 与 isolated 两个带不同 Thread environment 的 Session；惰性 transport 可由 fixture 的 `activateIsolated` 执行一个真实最小 native Turn/必需初始化，并用 driver 提供的 observer 等待 terminal。driver 独占该 Session 的 `outputs`；activation callback 的 Session 参数在类型上排除了 `outputs`，不得再次迭代。
2. primary 的首轮必须产生真实 native Turn identity；之后才读取 primary 与 isolated 的 native environment，确保两侧 native 载体都已建立且仍归当前 driver 所有。
3. 拒绝并发 start；等待实际 `turn.started` 后才发 cancel，观察真实 terminal、identity readback、fresh Adapter resume 和 follow-up。
4. 关闭所有已知 Session/Adapter，等待输出迭代器终结，并由 fixture 读取 owned native residue。

收据包含 `hostSha`、`pluginBundleSha256`、`nativeVersion`、platform、mode、inspection/Session capability snapshot、逐场景结果、identity/readback、environment activation/readback 与逐资源 cleanup。未知原生版本必须写 `nativeVersion: null`，不能猜测。environment 值、认证信息和 native 原始错误不会写入；失败场景仅记录稳定 `CONFORMANCE_ASSERTION_FAILED` 或 `CONFORMANCE_CLEANUP_FAILED` 与本地阶段原因。失败会抛出含部分收据的 `HarnessConformanceFailure`，所以 inspect/create 前失败也会保留 null identity 与实际清理结果。

```ts
async function createFreshLoaderAdapter(): Promise<HarnessAdapter> {
  const harnessId = harnessIdSchema.parse("example");
  const registry = await loadHarnessPlugins({
    roots: pluginRoots,
    context: pluginContext,
    onlyIds: new Set([harnessId]),
    warmup: false,
  });
  const adapter = registry.adapters.get(harnessId);
  if (!adapter) {
    await registry.close();
    throw new Error("CONFORMANCE_ADAPTER_NOT_LOADED");
  }
  return {
    harnessId: adapter.harnessId,
    ...(adapter.commandCatalog ? { commandCatalog: adapter.commandCatalog } : {}),
    ...(adapter.subagents ? { subagents: adapter.subagents } : {}),
    inspect: (input) => adapter.inspect(input),
    open: (input) => adapter.open(input),
    close: () => registry.close(),
  };
}

const receipt = await runAdapterConformance({
  createAdapter: createFreshLoaderAdapter,
  cwd: workspace,
  evidence: {
    hostSha,
    pluginBundleSha256: buildReceipt.bundleSha256,
    nativeVersion: observedNativeVersion ?? null,
    platform: process.platform,
    mode: "bundle-loader",
  },
  environment: {
    primary: { CODEXHOST_THREAD_ID: "conformance-primary" },
    isolated: { CODEXHOST_THREAD_ID: "conformance-isolated" },
    resume: { CODEXHOST_THREAD_ID: "conformance-resume" },
  },
  prompts: { first: "first", cancellable: "fixture-hold", followup: "followup" },
  probes: {
    activateIsolated: async (session, observer) => {
      const turnId = hostTurnIdSchema.parse("conformance-isolated");
      const accepted = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "fixture isolated activation" }],
      });
      if (!accepted.ok) throw new Error(accepted.error.code);
      const terminal = await observer.waitForTerminal(turnId);
      if (terminal.outcome.status !== "succeeded")
        throw new Error("CONFORMANCE_ISOLATED_TURN_FAILED");
    },
    assertEnvironmentIsolation: async () => nativeFixture.assertThreadEnvironments(),
    readCleanup: async () => ({ residue: nativeFixture.hasOwnedResidue() ? "present" : "none" }),
  },
});
await writeFile(receiptPath, serializeConformanceReceipt(receipt));
```

`fork`、`rollback`、`permissionAtCreate`、`subagents` 均为能力条件：未声明是 `skipped`；声明但 fixture 没有执行原生场景是 `notCovered`；只有原生场景验证 identity/readback/cleanup 后才能是 `passed`。

收据顶层区分 `passed`、`incomplete` 和 `failed`：任何失败优先为 `failed`；存在 `notCovered` 或缺少原生清理读回时为 `incomplete`；只有全部适用场景及清理证据完成才为 `passed`。不支持能力的 `skipped` 不会降低状态。当前十个 Adapter 的核心生命周期回归通过时，仍可能正确返回 `incomplete`，不能把这个结果称为全能力认证。

当前十个 Adapter 都已接入同一 driver。下面的证据来自实际 Adapter 和可控 native 边界；它不代表安装 Bundle、真实 Provider、Desktop 重启或所有可选能力已通过。最终执行结果见[整改验证报告](full-project-review-2026-09-12/remediation/README.md)。

| Adapter | 实际接线 | 验证边界 |
| --- | --- | --- |
| CodeBuddy | `CodeBuddyAdapter` + native client fixture；生成/回读 receipt，覆盖惰性 identity 和失败 cleanup | 测试在 Adapter 自己的 `test/conformance.test.ts`，通过公共子路径使用 driver |
| Cursor | `CursorAdapter`/Session/projection/resume + ACP/history fixture | 不等同于安装态 SQLite 或 Cursor live 验收 |
| Grok | 实际 Adapter + ACP fixture，覆盖 create/cancel/fresh resume | 未执行的私有扩展能力仍为 `notCovered` |
| Claude Code | 实际 SDK transport fixture；`activateIsolated` 驱动惰性 Session，读取两份 environment | 不发起真实 Provider 请求 |
| Antigravity | 实际 Adapter + child-process fixture，读取 marker/PID/native identity并确认进程退出 | 原生私有 DB/schema 需要目标版本独立验收 |
| DeepSeek Harness | Modern Adapter + native journal fixture，覆盖独立 Web carrier、resume 和 close | fixture profile 与实际安装原生版本分开记录 |
| Pi | 实际 Adapter + RPC fixture；`activateIsolated` 建立惰性 transport | 不把 fixture 当作真实 Pi 二进制 |
| OMP | 实际 Adapter + RPC fixture；create 完成当前 transport 订阅探测后发布 Session | 原生方法是否支持以该 transport 探测为准 |
| OpenCode | 实际 Adapter + SDK transport fixture | 不把 SDK 版本当作实际 server 版本 |
| Kiro | 实际 Adapter + ACP fixture | 不替代 Kiro engine/原生历史验收 |

所有 fixture 的未知 `nativeVersion`/Bundle SHA 保持 `null`。公共 driver 的通过范围是本次实际执行的场景，不能因为核心生命周期通过就把未执行的 fork、rollback、permission 或 subagent 场景提升为通过。
