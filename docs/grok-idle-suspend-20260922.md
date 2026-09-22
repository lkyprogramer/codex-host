# Grok 常驻进程接入空闲挂起（2026-09-22）

## 已观察事实

- 安装版 Host（`host-runtime.mjs`）下残留多枚 `grok agent --no-leader [--model grok-4.7] stdio`。父进程链是 Codex Desktop → `codexhost-shim` → Host。状态 `Ss`，标准输入输出连着 Host 的 unix socket，没有子进程，不在 Grok 自己的活动会话列表里。
- 启动时间按 Codex 委派的 worktree 成批出现。回合结束后进程仍挂在 Host 上；关掉终端不会回收它们。
- 修复前 `GrokHarnessSession` 没有 `resourceLifecycle`。`external-thread-runtime.ts` 发现该字段缺失后不武装 60 秒空闲计时。显式 `stopOwnedJobs` 会停任务并确认进程组退出，不是无副作用的空闲挂起。

## 修复内容

1. `GrokHarnessSession.resourceLifecycle.suspend`：信号已中止，或 Session 已关闭 / 故障，返回 `unknown`；活动 Turn、压缩、配置、待回答审批，或 `#backgroundSubagents` 仍有原生后台子代理，返回 `busy`；还没有核对过的 Native Turn，返回 `unknown`。准入通过后同步进入 closing，再释放受管进程组。成功时 scope 为 `grok-acp-session`，并结束输出通道。
2. 空闲释放调用 `releaseOwnedProcess`。Unix 下先结束 stdin，再给 leader 一段有界时间按 EOF 自行退出（`updates.jsonl` 由它写完），随后用 `trackOwnedProcessTree` 确认整个受管进程组退出；Windows 不先送 EOF，直接走 taskkill 进程树关闭，因为 root 先退出后无法再确认整棵树。不调用 ACP `session/close`，也不调用 `_x.ai/session/delete`。本地 `updates.jsonl` 仍是 `session/load` 的恢复来源。显式 `close` / `stopOwnedJobs` 仍会发送 `session/close`（能力声明存在时）。
3. 进程组没有退出时释放失败，Transport 不标记为已关闭，Session 回到 open，返回 `unknown` 并带上原始失败原因，Host 按既有退避重试；重试会重新升级 TERM → KILL。不新增数量上限。打开已挂起 Thread 的完整历史读取仍会拉起一个新的 `grok agent`，空闲 60 秒后再退出。
4. 后台子代理只以原生 `subagent.finished` 为结束依据：父 Turn 无论成功、取消还是失败，仍在跑的后台子代理都记入 `#backgroundSubagents`；该事件在后续 Turn 进行中到达时由 Prompt 通道投递，同样清除记录。两条路径缺一，都会让这条 Thread 永远 `busy` 或提前杀掉仍在跑的子代理。
5. `thread release` 语义：Host 对声明了合同的 Harness 先试挂起。`busy` 保持 busy；`unknown`（例如尚无已落盘 Turn）继续走 Grok 原有的 `stopOwnedJobs` 停止并确认，`released=true`。挂起成功时按公共合同返回 `released=false, resourcesReleased=true, quiescence=unknown`。

Host 的计时、操作串行和输出代次没有改。Grok 声明合同之后，现有 60 秒阈值自动生效。

## 真实 CLI

隔离 `HOME` 时 `session/new` 因没有登录凭证失败，进程已结束。使用本机凭证、临时 cwd 再探一次：空 `session/new` 不写 `updates.jsonl`，杀掉进程后 `session/load` 没有可恢复身份。这和“尚无已核对 Native Turn 则不挂起”一致。另一次对已有本地会话（34 天前的 `updates.jsonl`）连续两次 `session/load`，中间只结束进程、不发 `session/close`，两次都返回了模型与配置，没有协议错误。会话目录未删除。

默认测试不启动真实 `grok`。进程组回收由 ACP fixture 证明：idle release 不发送 `session/close` 也不发送任何 delete，leader 按 stdin EOF 自行退出（fixture 记录未收到 SIGTERM），忽略 SIGTERM 的子孙被强制回收；显式 close 仍发送 `session/close`。已经挂在当前 Desktop Host 上的进程不会因源码修改消失，需要安装并重启 Host 之后，新的空闲 Thread 才会被回收。
