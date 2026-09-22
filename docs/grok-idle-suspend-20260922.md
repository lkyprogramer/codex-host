# Grok 常驻进程接入空闲挂起（2026-09-22）

## 已观察事实

- 安装版 Host（`host-runtime.mjs`）下残留多枚 `grok agent --no-leader [--model grok-4.7] stdio`。父进程链是 Codex Desktop → `codexhost-shim` → Host。状态 `Ss`，标准输入输出连着 Host 的 unix socket，没有子进程，不在 Grok 自己的活动会话列表里。
- 启动时间按 Codex 委派的 worktree 成批出现。回合结束后进程仍挂在 Host 上；关掉终端不会回收它们。
- 修复前 `GrokHarnessSession` 没有 `resourceLifecycle`。`external-thread-runtime.ts` 发现该字段缺失后不武装 60 秒空闲计时。显式 `stopOwnedJobs` 会停任务并确认进程组退出，不是无副作用的空闲挂起。

## 修复内容

1. `GrokHarnessSession.resourceLifecycle.suspend`：信号已中止，或 Session 已关闭 / 故障，返回 `unknown`；活动 Turn、压缩、配置、待回答审批，或 `#backgroundSubagents` 仍有原生后台子代理，返回 `busy`；还没有核对过的 Native Turn，返回 `unknown`。准入通过后同步进入 closing，再释放受管进程组。成功时 scope 为 `grok-acp-session`，并结束输出通道。
2. 空闲释放调用 `releaseOwnedProcess`。它结束 stdin，并用 `trackOwnedProcessTree` 对 spawn 时登记的进程组做 TERM → KILL。不调用 ACP `session/close`，也不调用 `_x.ai/session/delete`。本地 `updates.jsonl` 仍是 `session/load` 的恢复来源。显式 `close` / `stopOwnedJobs` 仍会发送 `session/close`（能力声明存在时）。
3. 进程组没有退出时返回 `unknown`，不结束输出，Host 按既有退避重试。不新增数量上限。打开已挂起 Thread 的完整历史读取仍会拉起一个新的 `grok agent`，空闲 60 秒后再退出。

Host 的计时、操作串行和输出代次没有改。Grok 声明合同之后，现有 60 秒阈值自动生效。

## 真实 CLI

隔离 `HOME` 时 `session/new` 因没有登录凭证失败，进程已结束。使用本机凭证、临时 cwd 再探一次：空 `session/new` 不写 `updates.jsonl`，杀掉进程后 `session/load` 没有可恢复身份。这和“尚无已核对 Native Turn 则不挂起”一致。另一次对已有本地会话（34 天前的 `updates.jsonl`）连续两次 `session/load`，中间只结束进程、不发 `session/close`，两次都返回了模型与配置，没有协议错误。会话目录未删除。

默认测试不启动真实 `grok`。进程组回收由 ACP fixture 证明：idle release 不发送 `session/close`，leader 与忽略 SIGTERM 的子孙都会退出；显式 close 仍发送 `session/close`。已经挂在当前 Desktop Host 上的进程不会因源码修改消失，需要安装并重启 Host 之后，新的空闲 Thread 才会被回收。
