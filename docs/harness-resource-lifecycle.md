# Harness 资源生命周期

Host Thread 的持久化身份与原生进程的存活期不同。Thread 可以继续存在于 Desktop 中，而不让每个已完成任务永久占用一个 CLI / Server 进程。

## 统一合同

公共入口是 [`HarnessSession.resourceLifecycle`](../packages/harness-adapter/src/text-session.ts)，Host 通过 [`ManagedHarnessSession`](../packages/host-runtime/src/managed-harness-session.ts) 管理可挂起实例。它不依赖具体 Harness 名称，也不把所有 CLI 假定成 ACP。

Host 在符合条件的 Session 空闲 60 秒后尝试挂起。Adapter 的 `suspend(signal)` 必须在自身原生生命周期内完成检查和关闭；分别返回 `suspended`、`busy`、`unknown` 或 `unsupported`。Host 不把一次 idle 查询当作随后强制关闭的授权。

- 有活动 Turn、配置、待回答交互、后台子代理或自主任务时不能挂起。
- 成功挂起保留原生 Session 身份、历史及配置；后续操作通过同一原生身份恢复。
- Host 保留轻量 Thread 和输出通道。原生输出因挂起正常结束，不应被误报为 Session 故障；恢复后的旧代迟到事件不能污染新代。
- 挂起与恢复、发送、配置、完整历史读取及历史派生共享操作保护。超时不能让尚未完成的关闭与新操作并发。
- `status` / `wait-many` 读取 Host 状态，不唤醒挂起进程。完整历史 / evidence 读取可以恢复原生连接，以保留真实历史语义。
- `executionReady=false` 的 history-only Session 被挂起后，读取以 history-only 恢复；只有执行才升级为 live Session。
- 未声明合同的旧插件保持兼容，自动回收明确不启用；不能为了统一行为而取消未知后台工作。

## 释放范围与任务静默

`thread release` 的 `resourcesReleased=true` 只证明返回 `proof.scope` 范围内的原生资源已释放。它可以与 `released=false`、`quiescence=unknown` 同时出现：Thread 保留可恢复状态，但不能据此删除工作树或业务资源。

挂起返回 `busy` 时 `thread release` 保持 busy，不做破坏性释放；返回 `unknown` 或 `unsupported` 时，具备显式 owned-job 接口的 Harness 仍走原有的停止与确认路径，空闲挂起不可用不等于这条 Thread 没有释放方式。

`quiescence=confirmed` 与资源挂起是不同的证明。受管进程组退出不覆盖工具自行创建的独立进程组、远端任务、容器任务或外部业务处理。取消请求成功、父 Turn 结束和进程内存下降，都不能替代这些任务的静默证明。

## 进程所有权

清理只能针对 Adapter 创建并跟踪的资源。禁止通过进程名称批量结束同名 CLI，或把截图中的 PID 当作永久有效的所有权依据。

Adapter 只通过 `harness-discovery` 的 `spawnOwnedProcess` 创建自己拥有的 Harness 进程，不直接对 pid 发信号；`tools/check-boundaries.mjs` 禁止生产代码出现 `process.kill(-pid)`。macOS 与 Linux 上，Shim 注入 `CODEXHOST_PROCESS_ANCHOR_PATH`，每个 Harness 由原生 `codexhost-anchor` 启动并拥有（设计见[进程 Anchor 与整改计划](process-anchor-remediation-plan.md)）：

- anchor 以独立进程组创建 Harness，并在组内还有存活成员时绝不回收 leader，所以组号不可能被复用；对组发信号永远只命中本次 spawn，失败后的重试天然安全。
- 关闭为有界 TERM → KILL，只有组内不再有非僵尸成员才报告已释放；只剩僵尸不再与「仍存活」混淆。
- leader 自行退出时，anchor 立即回收它留下的 MCP、后台 shell 等进程；Host 看到的 `exit` 仍是 Harness 自己的退出码或信号，只是在组清空之后才到达。
- Host 以任何方式退出（包括被 SIGKILL）时，anchor 的控制通道断开，它独立结束整组，Shim 是否存活都不影响。
- Linux 上 anchor 是 subreaper，`setsid` / double fork 逃出组的后代会被收养并一并回收；macOS 没有对应原语，这类后代仍依赖 Shim 的全局账本兜底。

Windows、或找不到 anchor 的开发环境回退到 Host 侧 tracker：leader 退出即开始回收，失败后不重放（它只持有 pid），按未确认失败处理。丢失所有权或无法验证退出时返回失败，不能报告成功。

不同 Session 的环境、执行策略和 cwd 仍保持隔离；资源回收不是把所有 Session 合并到一个共享 Server。

## 原生依据与验收

[OpenCode Server API](https://opencode.ai/docs/server/) 区分查询 Session 状态和删除 Session 数据；资源回收不能调用删除接口替代断开 Server。[ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup) 将关闭定义为取消活动工作并释放资源；仅有 ACP close 能力不足以证明当前无后台工作或实现具备关闭后恢复保障。

新增或启用一个 Adapter 的自动挂起，需要定向覆盖：空闲回收、活动与交互拒绝、后台子任务、取消信号、关闭失败、并发唤醒、同一身份与配置恢复，以及真实受管进程退出。模型聊天成功、stub 的 `close` 被调用和主进程退出都不能单独替代这组证据。

本次排查与各 Harness 的当前接入状态、验证结果见 [2026-09-13 排查记录](harness-resource-review-20260913.md)。Cursor 于 2026-09-19 接入统一合同，见 [Cursor 空闲挂起记录](cursor-idle-suspend-20260919.md)。Grok 于 2026-09-22 接入同一合同：空闲时释放受管 ACP 进程组，不调用 `session/close` 或 `_x.ai/session/delete`，后台子代理未结束时拒绝挂起。见 [Grok 空闲挂起记录](grok-idle-suspend-20260922.md)。

2026-09-23 补齐 Claude Code 的同类缺口：

- 原生后台任务（包括 `run_in_background` Shell，不只是子代理）未结束时拒绝挂起。判断只依据 Claude 的 `background_tasks_changed` 电平集合，不依据可能乱序或遗漏的 task 边沿事件；关闭时也只等待电平集合中的任务结束，仅见于边沿的 id（例如前台 Task）只尽力请求停止，不等待其终态。
- 释放失败返回 `unknown` 并保留旧 Transport 的所有权，失败原因经 `thread release` 的 `reason` 返回。Host 下次空闲重试、下一次启动或 Session 关闭都会先重试释放；确认前不启动新进程、不允许 rollback：`turn.start` 直接以可重试的 `unavailable`（「上一进程未确认停止」）拒绝，不会开始 Turn。已拆除的 Transport 不再向 Session 投递迟到输出，重试时也不再等待这些输出排空，只重新确认受管进程组。
- 释放未确认期间，若旧进程仍在运行并写入原生历史，这部分输出不会投影到 Host；Session 重新可用后，Host 视图可能落后于原生历史，直到下一次完整读取。准入已排除活动 Turn 与后台任务，此时进程应无原生工作，因此只是残余风险。
- 重试时若 leader 已被回收且其 pid 已被其他进程占用，即判定受管组已空，不再发信号；EPERM 按组仍存在继续等待。

剩余边界：两次尝试之间若受管组已自然清空，而其 pid 恰被新进程复用为另一个组的 leader、且该 leader 随后退出只留下组员，仅凭 pid 无法区分，重试的组信号会落到那个组上。这与 Grok 的所有权模型相同，概率低但不可排除；彻底消除需要为组成员记录独立的身份证据。
