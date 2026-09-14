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
- 未声明合同的旧插件保持兼容，自动回收明确不启用；不能为了统一行为而取消未知后台工作。

## 释放范围与任务静默

`thread release` 的 `resourcesReleased=true` 只证明返回 `proof.scope` 范围内的原生资源已释放。它可以与 `released=false`、`quiescence=unknown` 同时出现：Thread 保留可恢复状态，但不能据此删除工作树或业务资源。

`quiescence=confirmed` 与资源挂起是不同的证明。受管进程组退出不覆盖工具自行创建的独立进程组、远端任务、容器任务或外部业务处理。取消请求成功、父 Turn 结束和进程内存下降，都不能替代这些任务的静默证明。

## 进程所有权

清理只能针对 Adapter 创建并跟踪的资源。禁止通过进程名称批量结束同名 CLI，或把截图中的 PID 当作永久有效的所有权依据。

Unix 下独立进程组的 leader 退出不代表组内子孙进程退出。关闭需要有界 TERM → KILL，并观察整个受管组的退出；Windows 需要平台自己的进程树关闭与结果检查。丢失所有权或无法验证退出时返回失败，不能报告成功。

不同 Session 的环境、执行策略和 cwd 仍保持隔离；资源回收不是把所有 Session 合并到一个共享 Server。

## 原生依据与验收

[OpenCode Server API](https://opencode.ai/docs/server/) 区分查询 Session 状态和删除 Session 数据；资源回收不能调用删除接口替代断开 Server。[ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup) 将关闭定义为取消活动工作并释放资源；仅有 ACP close 能力不足以证明当前无后台工作或实现具备关闭后恢复保障。

新增或启用一个 Adapter 的自动挂起，需要定向覆盖：空闲回收、活动与交互拒绝、后台子任务、取消信号、关闭失败、并发唤醒、同一身份与配置恢复，以及真实受管进程退出。模型聊天成功、stub 的 `close` 被调用和主进程退出都不能单独替代这组证据。

本次排查与各 Harness 的当前接入状态、验证结果见 [2026-09-13 排查记录](harness-resource-review-20260913.md)。
