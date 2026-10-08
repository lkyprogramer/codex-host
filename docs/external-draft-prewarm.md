# 外部 Harness 草稿预热

Codex Desktop 会在用户开始输入前预热草稿：提前发一个 `thread/start`，让 Session 先打开。草稿选的是外部 Harness 时，这个请求由 Host 处理，Host 会为它打开 Harness Session，可能启动原生进程（例如 Claude Code）。用户可能根本不发送这个草稿：换了 Model、清空草稿或关掉窗口。本文描述预热在 Host 中的生命周期。

## 标记

Desktop Control（`renderer-draft-prewarm-runtime.ts`）只给外部 Harness、非 ephemeral 的预热 `thread/start` 加上 `codexhostPrewarm: true`（`EXTERNAL_THREAD_PREWARM_PARAM`）。正式创建和官方 Codex 的预热不加标记，行为不变。

## 不进入历史

带标记的外部 Thread 是“未提交的预热”：

- 即使 Harness 已经报告了 Native Session 身份，Host 也只把它留在内存的 Session 状态里，映射记录保持 `creating`；
- 不发出 `thread/started`，会话列表也不展示（列表只展示 `ready` 的记录）；
- 读取它（例如 `thread/read`）得到空历史，不会报错。

普通外部 Thread 同样只在原生身份提交、记录变为 `ready` 时才发出 `thread/started`：创建时就有身份的立即发布，身份晚到的在提交时发布。

## 提交

用户第一次在预热里发起 Turn、执行原生命令，或 Harness 自己开始一个原生 Turn 时，Host 先把内存中的身份提交到映射记录，再发布 `thread/started`，然后才执行这次工作。提交失败时这次工作不执行，草稿仍保持隐藏。身份还没报告的，由之后的 Session 状态事件提交并发布。

读取、恢复或选择配置会“接管”预热（之后的释放请求不再关闭它），但不会发布它。

## 释放

Desktop Control 在以下时机向 Host 发送 `codexhost/thread/prewarm/discard { threadId }`（`THREAD_PREWARM_DISCARD_METHOD`）：

- 草稿选择的外部 Model 变化；
- 草稿被清空；
- Desktop Control 的这条 Host 连接被替换或销毁。

预热还在打开时草稿就变了，返回的预热会被释放，并以错误结束，不交给 Desktop 使用。

Host 在该 Thread 的请求队列内处理释放，结果为 `{ discarded: boolean }`：

- 已被用户工作接管的、正在运行或有历史的、Session 报告仍有原生后台工作的预热，以及普通 Thread，都不释放（`discarded: false`）；
- 否则关闭 Session、等待输出结束、删除映射记录（`discarded: true`）；重复释放没有副作用；
- 关闭未能确认时返回 `-32075`，并拒绝之后对这个 Thread 的用户工作（`-32075 External prewarm close was not confirmed`），避免旧进程可能还在运行时再启动一个原生写入者。

释放是尽力而为的维护请求：连接已断开时不会重放，也不会因此让用户的提交失败。

## 与空闲释放的关系

未提交的预热不参与空闲释放：它的身份不在映射记录里，被释放后无法为用户的第一条消息恢复。它一直保持打开，直到 Desktop 释放它、用户接管它，或 Host 退出。Desktop 异常退出、来不及发送释放请求时，这个预热会保留到 Host 退出；每个草稿最多一个。

## 验证

- `packages/host-runtime/test/app-server-host.test.ts` 的 “external draft prewarms”：预热不发布、首次 Turn 时提交并发布；身份晚到的普通 Thread 与预热；只释放未接管的预热（含通过 `thread/resume` 接管）。
- `packages/host-runtime/test/external-thread-prewarms.test.ts`：释放、接管、后台工作、关闭未确认后拒绝用户工作。
- `packages/host-runtime/test/external-thread-runtime.test.ts`：未提交的预热不空闲释放。
- `packages/host-runtime/test/external-thread-repository.test.ts`：未发送草稿的快照对齐。
- `packages/desktop-control/test/renderer-draft-prewarm-policy.test.ts`：标记、换 Model / 清空 / 销毁时释放、接管后不释放、草稿变化后返回的预热被释放、官方预热不受影响。

“关闭未确认”的 Host 级路径没有集成测试：`ManagedHarnessSession` 关闭失败后会按 1、5、30 秒重试，该路径由单元测试覆盖。没有在真实 Desktop 上验证。

来源：借鉴上游 `bac41c30`、`6897e530`、`aeae5642`（BytePioneer-AI/codex-host，#482）；fork 用 Session 资源生命周期判断后台工作，并让未提交的预热不参与空闲释放。见 [上游对比 V07](upstream-comparison-20261007/README.md)。
