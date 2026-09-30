# R2 Astra / high independent review

Runtime verified: CLI session `01a0dbc5-992e-7770-b346-744534689a09`, persisted turn_context `model=gpt-6-astra`, `effort=high`. Read-only; no tests executed by reviewer.

发现 **1 项 P2，未发现 P1**。

- **P2：U12 的新状态无法及时使终态刷新失效。** 位置：[app-server-host.ts:4698](/Users/luo/Documents/github/codex-host-r1/packages/host-runtime/src/app-server-host.ts:4698)。当已打开的子代理进入 idle、历史读取尚未完成时，同一原生事件流再次发出 running，[事件消费循环:4185](/Users/luo/Documents/github/codex-host-r1/packages/host-runtime/src/app-server-host.ts:4185)仍在等待整个终态刷新循环，因此 running 无法更新 token，`isCurrent()` 仍为真。旧刷新继续发送完成／idle 通知，期间重新打开子线程也会读到错误的 idle 状态；后续父线程事件同时受阻。这是 U12 修复未闭合的路径。建议将延迟刷新作为受管理任务执行，让事件消费继续推进，并以转换 token 限制结果应用和通知。补充通过真实输出队列注入“终态→阻塞读取→running→释放读取”的测试；[现有测试:833](/Users/luo/Documents/github/codex-host-r1/packages/host-runtime/test/app-server-host.test.ts:833)直接调用 token helper，绕过了该串行调用链。

此前 `readSnapshot() !ok` 清理问题已静态确认修复：[external-thread-fork.ts:204](/Users/luo/Documents/github/codex-host-r1/packages/host-runtime/src/external-thread-fork.ts:204)进入统一清理分支，返回原生 ID、Host ID 和清理失败项；新增 readback fixture 覆盖了两项清理同时失败。

其余指定范围未发现明确 P1/P2。R1 基线的 **15 个文件哈希全部一致**，未将其归为 R2；U15 未纳入审查。

**本次运行测试：0。** `RESULT.md` 中的通过记录均为 owner 报告，未独立执行。真实 Harness 权限恢复／取消、macOS 锁争用、Desktop attachment、OpenCode 进程树及目录回收、跨平台运行均未验证。全程只读，无修改、代理、构建、Desktop 启动或提交推送。

Historical review: the U12 finding was subsequently fixed and re-reviewed through native Astra/high. See REPAIR.md for final closure and validation.
