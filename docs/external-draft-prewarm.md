# 外部 Harness 草稿预热

Codex Desktop 会在用户开始输入前预热草稿：提前发一个 `thread/start`，让 Session 先打开。草稿选的是外部 Harness 时，这个请求由 Host 处理，Host 会为它打开 Harness Session，可能启动原生进程（例如 Claude Code）。用户可能根本不发送这个草稿：换了 Model、清空草稿或关掉窗口。本文描述预热在 Host 中的生命周期。

## 标记

Desktop Control（`renderer-draft-prewarm-runtime.ts`）只给外部 Harness、非 ephemeral 的预热 `thread/start` 加上 `codexhostPrewarm: true`（`EXTERNAL_THREAD_PREWARM_PARAM`）。正式创建和官方 Codex 的预热不加标记，行为不变：草稿变化时，进行中的官方预热照常返回，只是不再发布过期的工作区。

## 不进入历史

带标记的外部 Thread 是“未提交的预热”：

- 即使 Harness 已经报告了 Native Session 身份，Host 也只把它留在内存的 Session 状态里，映射记录保持 `creating`；
- 不发出 `thread/started`，会话列表也不展示（列表只展示 `ready` 的记录）；
- 读取它（例如 `thread/read`）得到空历史，不会报错。

普通外部 Thread 同样只在原生身份提交、记录变为 `ready` 时才发出 `thread/started`：创建时就有身份的立即发布，身份晚到的在提交时发布。创建时没有身份的 Harness（例如 Claude Code、OMP）因此要到第一个 Turn 开始、身份报告之后才发布。每个 Thread 只发布一次：身份提交和委派流程等多条路径都可能发布同一个 Thread，后来的会被忽略。

## 提交

用户第一次在预热里发起 Turn、执行 Harness 提供的原生命令，或 Harness 自己开始一个原生 Turn 时，Host 先把内存中的身份提交到映射记录，再发布 `thread/started`，然后才执行这次工作。提交失败时这次工作不执行（返回 `-32081`），草稿仍保持隐藏，下一次提交会重试。身份还没报告的，由之后的 Session 状态事件提交并发布。

提交发生在 Thread 被占用之前：发起 Turn 时，提交完成后才检查 Thread 是否空闲并占用它；执行原生命令时，提交在命令准入阶段、确认 Harness 提供这个命令之后完成，准入期间的中断会取消命令；不存在的命令不会提交预热。检查与占用之间没有 await，两个请求不会同时占用同一个原生 Session。

读取、恢复或选择配置会“接管”预热（之后的释放请求不再关闭它），但不会发布它。这样被接管、却一直没有提交工作的预热，既不能再被释放，也不参与空闲释放（见下），会保持打开到 Host 退出；提交失败后未再提交的预热也一样。

## 释放

Desktop Control 在以下时机向 Host 发送 `codexhost/thread/prewarm/discard { threadId }`（`THREAD_PREWARM_DISCARD_METHOD`）：

- 草稿选择的外部 Model 变化；
- 草稿被清空；
- Desktop Control 的这条本机 Host 连接被替换或销毁。这时连接已不是当前连接，释放请求仍通过这条旧连接直接发出。

Remote Control Host 的连接被替换或销毁时不发送释放请求：bridge 进程随即被结束，排在后面的请求写不出去。每条 Remote Control 连接在 Host 中有自己的会话，bridge 断开后，这个会话结束时会关闭它打开的所有 Harness Session，预热也在其中；映射记录停在 `creating`，由下次 Host 启动时的 Mapping Store 清理删除。

预热还在打开时草稿就变了，返回的预热会被释放，并以错误结束，不交给 Desktop 使用。

Host 在该 Thread 的请求队列内处理释放，结果为 `{ discarded: boolean }`：

- 已被用户工作接管的、正在运行或有历史的、Session 报告仍有原生后台工作的预热，以及普通 Thread，都不释放（`discarded: false`）；
- 否则关闭 Session、等待输出结束、删除映射记录（`discarded: true`）；重复释放没有副作用；
- 关闭未能确认时返回 `-32075`，并拒绝之后对这个 Thread 的用户工作（`-32075 External prewarm close was not confirmed`），避免旧进程可能还在运行时再启动一个原生写入者；
- 释放正在关闭 Session 时到达的接管请求同样被拒绝（`-32075 External prewarm is being released`）。原生命令不排在 Thread 的请求队列里，靠这条规则避免命令落在正在关闭的 Session 上。

释放是尽力而为的维护请求：连接已断开时不会重放，也不会因此让用户的提交失败。释放只删除 Host 的映射；OpenCode、Cursor 等在打开时就创建原生会话的 Harness，其原生存储中的空会话仍然保留。预热在被接管前因故障结束时，映射记录停在 `creating`，由下次 Host 启动时的 Mapping Store 清理删除。

## 与空闲释放的关系

未提交的预热不参与空闲释放：它的身份不在映射记录里，被释放后无法为用户的第一条消息恢复。它一直保持打开，直到 Desktop 释放它、用户接管它，或 Host 退出。Desktop 异常退出、来不及发送释放请求时，这个预热会保留到 Host 退出；每个草稿最多一个。

## 验证

- `packages/host-runtime/test/app-server-host.test.ts` 的 “external draft prewarms”：预热不发布、首次 Turn 时提交并发布；原生命令与原生自主 Turn 提交预热；不存在的命令不提交预热；Turn 提交身份期间到达的原生命令先占用 Thread 时，Turn 被拒绝且 `thread/started` 只发布一次；提交失败时不执行用户工作；身份晚到的普通 Thread 与预热；只释放未接管的预热（含通过 `thread/resume` 接管）。
- `packages/host-runtime/test/external-thread-prewarms.test.ts`：释放、接管、后台工作、关闭未确认后拒绝用户工作、释放进行中拒绝接管。
- `packages/host-runtime/test/external-thread-runtime.test.ts`：未提交的预热不空闲释放。
- `packages/host-runtime/test/external-thread-repository.test.ts`：未发送草稿的快照对齐。
- `packages/desktop-control/test/renderer-draft-prewarm-policy.test.ts`：标记、换 Model / 清空 / 销毁时释放、连接已不是当前连接时销毁仍释放（按 Renderer 注入方式序列化执行）、Remote Control 连接销毁时不再排队释放请求、接管后不释放、草稿变化后返回的预热被释放、官方预热不受影响（含草稿变化后返回的官方预热）。

没有自动化测试的部分：“关闭未确认”的 Host 级路径（`ManagedHarnessSession` 关闭失败后会按 1、5、30 秒重试，由单元测试覆盖）；Remote Control 连接断开后 Host 会话关闭预热 Session 的端到端路径（Remote Control bridge 只在 Windows 上可用）。没有在真实 Desktop 上验证。

已知差异：

- Harness 自己开始的原生 Turn 提交身份失败时，整个 Session 以失败结束；用户发起的工作提交失败则返回 `-32081`、可以重试。
- `thread/started` 按 Thread 只发布一次，因此对已有映射的原生 Session 重复导入时不会再次发布。

来源：借鉴上游 `bac41c30`、`6897e530`、`aeae5642`（BytePioneer-AI/codex-host，#482）；fork 用 Session 资源生命周期判断后台工作，并让未提交的预热不参与空闲释放。见 [上游对比 V07](upstream-comparison-20261007/README.md)。
