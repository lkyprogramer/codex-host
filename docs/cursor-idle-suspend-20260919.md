# Cursor 常驻进程接入空闲挂起（2026-09-19）

## 已观察事实

- 活动监视器中数十个名为 `node` 的进程实际是 `cursor-agent --force acp`：`~/.local/bin/cursor-agent` 是 bash 包装，最终执行 `~/.local/share/cursor-agent/versions/<version>/node`。
- 49 个该进程全部是安装版 Host（`host-runtime.mjs`，PID 14704）的直接子进程，状态 `Ss`、0% CPU，fd 0/1/2 仍连接父进程的 unix socket；启动时间从 28 分钟到 10 小时以上，按委派 wave 成批出现。
- `ps` RSS 约 23 MB，活动监视器"内存"约 150–166 MB；两者是不同指标，本记录不据此推算释放量。
- 修复前 Cursor Adapter 没有实现 `resourceLifecycle`，Host 的空闲挂起在 [`external-thread-runtime.ts`](../packages/host-runtime/src/external-thread-runtime.ts) 检查到该字段缺失后直接跳过；`thread release` 返回 `released=false, quiescence=unsupported`（见 [2026-09-14 记录](cursor-acp-failure-20260914/README.md)）。因此 Cursor 进程只在 Host 退出或被外部终止时消失。

未安装或替换 npm 包，未重启当前 Desktop，未终止上述既有进程。

## 修复内容

1. [`CursorSession`](../packages/adapters/cursor-cli/src/adapter.ts) 实现公共 `resourceLifecycle.suspend`：信号已中止或 Session 已关闭 / 故障返回 `unknown`；存在活动 Turn、配置写入或快照读取（含 replay 进程）返回 `busy`；创建后尚无已验证原生 Turn 的 Session 返回 `unknown`，因为 `session/load` 依赖 Cursor 本地历史；其余情况关闭 ACP 进程并返回 `suspended`，scope 为 `cursor-acp-session`。准入检查到 `close()` 之间没有 await，`close()` 先同步标记关闭再等待进程树退出，输出通道在 `finally` 中结束。
2. [`ManagedHarnessSession`](../packages/host-runtime/src/managed-harness-session.ts) 对已挂起的 history-only Session（`executionReady=false`）的读取以 `historyOnly` 恢复，不升级为 live；恢复后按返回 Session 的 `executionReady` 重新判定是否仍为 history-only。Cursor 是当前唯一暴露 `executionReady` 的 Adapter；Desktop 重启后所有 Cursor Thread 以 history-only 恢复，没有这一步则每次历史读取都会拉起远程模型目录、模型配置和一个额外 replay 进程，并把目录失败放大为 Thread 故障。`#resumeSuspendedSession` 透传 `historyOnly`。
3. 没有引入数量上限或按创建时间淘汰。Host 已有的 60 秒空闲阈值与退避重试对 Cursor 生效，常驻数收敛为活跃 Thread 数；上限只在 Thread 长期不空闲时才有意义，目前没有这类证据。

保留边界：挂起后的下一次操作依赖原生 `session/load`；Cursor ACP 原生侧的不稳定（空目录、`Internal error`）会让恢复失败并使该 Thread 进入 fault，需要重新 resume。首个 Turn 原生校验失败的 Session 保持 `#fresh`，不会被挂起，Host 以最长 5 分钟间隔持续重试并记录一条诊断。挂起状态下的 `refreshUsage` 会为不实现该能力的 Adapter 做一次 history-only 恢复，属既有行为，未在本次处理。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js packages/adapters/cursor-cli packages/host-runtime/test/managed-harness-session.test.ts packages/host-runtime/test/external-thread-runtime.test.ts packages/host-runtime/test/harness-delegation-coordinator.test.ts` | 12 文件 163 项通过 |
| `npm run typecheck` | 通过 |
| `npm run lint`（含边界检查） | 通过 |
| Prettier 检查修改文件 | 通过 |
| `packages/host-runtime` 全量 | 修改前后失败集合分别为 10 项与 8 项，后者是前者子集；均为插件加载与 loopback 观察者的环境相关用例 |

新增定向用例：挂起后按同一 `nativeSessionId` 恢复并拒绝对已关闭 Session 的执行；`aborted` / 已关闭 / 未持久化三种 `unknown` 的精确原因；Turn 运行且审批待回答时 `busy`；快照读取持有 replay 进程时 `busy`；进程清理失败时拒绝报告挂起；Host 侧 history-only 挂起后读取以 history 恢复、执行才升级 live，以及 history 恢复意外返回 live Session 的处理。

两轮独立评审（Opus）：首轮 1 项 should-fix 即上文第 2 条，已按评审建议在 Host 侧修复；其余为测试断言精度与冗余概念，已处理。复审无 blocker、无 should-fix。

## 未覆盖

未运行真实 Cursor CLI：没有实测 60 秒后进程退出、`thread send` 唤醒和 Desktop 重启后 history-only 读取只启动一个进程。安装版 Host 没有热替换，截图中的既有进程不会因本次源码修改减少；后续发布 / 安装 / 重启需另行执行。Windows 未验证。
