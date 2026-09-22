# Grok 常驻进程接入空闲挂起（2026-09-22）

## 已观察事实

- 安装版 Host（`host-runtime.mjs`）下残留多枚 `grok agent --no-leader [--model grok-4.7] stdio`。父进程链是 Codex Desktop → `codexhost-shim` → Host。状态 `Ss`，标准输入输出连着 Host 的 unix socket，没有子进程，不在 Grok 自己的活动会话列表里。
- 启动时间按 Codex 委派的 worktree 成批出现。回合结束后进程仍挂在 Host 上；关掉终端不会回收它们。
- 修复前 `GrokHarnessSession` 没有 `resourceLifecycle`。`external-thread-runtime.ts` 发现该字段缺失后不武装 60 秒空闲计时。显式 `stopOwnedJobs` 会停任务并确认进程组退出，不是无副作用的空闲挂起。

## 修复内容

1. `GrokHarnessSession.resourceLifecycle.suspend`：信号已中止，或 Session 已关闭 / 故障，返回 `unknown`；活动 Turn、压缩、配置、待回答审批，或 `#backgroundSubagents` 仍有原生后台子代理，返回 `busy`；还没有核对过的 Native Turn，返回 `unknown`。准入通过后同步进入 closing，再释放受管进程组。成功时 scope 为 `grok-acp-session`，并结束输出通道。
2. 空闲释放调用 `releaseOwnedProcess`。Unix 下先结束 stdin，再给 leader 一段有界时间按 EOF 自行退出（`updates.jsonl` 由它写完），随后用 `trackOwnedProcessTree` 确认整个受管进程组退出；Windows 不先送 EOF，直接走 taskkill 进程树关闭，因为 root 先退出后无法再确认整棵树——这相对改动前是 Grok 破坏性 `close` 的行为变化（Windows 上 CLI 不再有 EOF 刷盘窗口），与 Kiro 的同类实现一致。不调用 ACP `session/close`，也不调用 `_x.ai/session/delete`。本地 `updates.jsonl` 仍是 `session/load` 的恢复来源。显式 `close` / `stopOwnedJobs` 仍会发送 `session/close`（能力声明存在时）。
3. 进程组没有退出时释放失败，Transport 不标记为已关闭，Session 回到 open，返回 `unknown` 并带上原始失败原因，Host 按既有退避重试。`trackOwnedProcessTree` 只持有 pid，一次清理失败后不再重放（否则会对可能被复用的 pid 发信号），因此重试改用 `owned-group.ts` 的 `reclaimOwnedGroup`。它在发信号前先判定所有权：

- leader 已不在：组 id 在成员未清空前不会被内核回收，所以剩下的必是本次 spawn 的子孙，可以发信号；
- 受管 ChildProcess 句柄还没看到退出（`exitCode`/`signalCode` 均为 null）：Node 尚未回收该子进程，即使它已是僵尸也仍占着这个 pid，内核不可能把 pid 交给别人，可以发信号；
- 句柄已看到退出、leader pid 却还活着，且 `startToken`（spawn 时 `ps -o lstart`）与当前读数一致：仍是本次 spawn，可以发信号；
- 同上但两者不一致：pid 已被复用，原组必然已经消失——判为已释放，且绝不对现在的占用者发信号；
- token 缺失或当前读不出来（`ps` 不可用、超时、被沙箱挡住，Windows 恒为空）：无法证明所有权，不发信号并按未确认失败。读不出来绝不能等同于「pid 已被复用」，否则会把仍在跑的进程组当成已释放。

确认所有权后再对同一进程组重新升级 TERM → KILL，只有观察到组消失才算释放。Windows 没有受管进程组，只能借活着的 root 用 taskkill `/T /F` 定位整棵树；root 已退出时这棵树不可达也不可知，返回未确认而不是成功。进程组只剩未回收僵尸时信号返回 EPERM，按「仍在退出」处理并等待预算用完；代价是真正无权限的清理会用满两轮预算才失败，失败信息里保留 EPERM。不新增数量上限。打开已挂起 Thread 的完整历史读取仍会拉起一个新的 `grok agent`，空闲 60 秒后再退出。
4. 后台子代理以原生结束信号为准，不以父 Turn 的结果为准：父 Turn 无论成功、取消还是失败，仍在跑的后台子代理都记入 `#backgroundSubagents`。清除门闩有三条路径，缺一条就会让这条 Thread 永远 `busy`：无 Prompt 在飞时的会话级 `subagent.finished`；后续 Turn 进行中经 Prompt 通道投递的同一事件；以及 wait / kill 工具输出驱动的结算（`#completeWatchedSubagents`，Grok 不会为它另发 `subagent.finished`）。反过来，任何一条在子代理仍在跑时误删，都会让空闲挂起提前杀掉它。
5. `thread release` 语义：Host 对声明了合同的 Harness 先试挂起。`busy` 保持 busy；`unknown`（例如尚无已落盘 Turn）继续走 Grok 原有的 `stopOwnedJobs` 停止并确认，`released=true`。挂起成功时按公共合同返回 `released=false, resourcesReleased=true, quiescence=unknown`。Session 已关闭或故障时会拒绝这条破坏性租约，此时 release 仍返回结构化的 `quiescence=unknown`，不把控制请求整体失败掉。

Host 的计时、操作串行和输出代次没有改。Grok 声明合同之后，现有 60 秒阈值自动生效。

## 真实 CLI

隔离 `HOME` 时 `session/new` 因没有登录凭证失败，进程已结束。使用本机凭证、临时 cwd 再探一次：空 `session/new` 不写 `updates.jsonl`，杀掉进程后 `session/load` 没有可恢复身份。这和“尚无已核对 Native Turn 则不挂起”一致。另一次对已有本地会话（34 天前的 `updates.jsonl`）连续两次 `session/load`，中间只结束进程、不发 `session/close`，两次都返回了模型与配置，没有协议错误。会话目录未删除。

受管进程树的 fail-closed 语义与 EPERM 处理由 `packages/harness-discovery/test/owned-process-tree.test.ts` 覆盖，Grok 侧的失败后重试由 `acp-process-release.test.ts` 覆盖。OpenCode 的 `#childStopPromise` 在失败时清空以便重试，但共享 tracker 不重放，这一点本次未改（`sdk-transport.test.ts` 明确断言失败后不得靠 pid 再猜所有权），如需让 OpenCode 真正重试应另行按同样的身份证据方式处理。默认测试不启动真实 `grok`。进程组回收由 ACP fixture 证明：idle release 不发送 `session/close` 也不发送任何 delete，leader 按 stdin EOF 自行退出（fixture 记录未收到 SIGTERM），忽略 SIGTERM 的子孙被强制回收；显式 close 仍发送 `session/close`。已经挂在当前 Desktop Host 上的进程不会因源码修改消失，需要安装并重启 Host 之后，新的空闲 Thread 才会被回收。
