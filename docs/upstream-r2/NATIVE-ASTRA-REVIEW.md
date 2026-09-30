# R2 原生 Astra / high 终审

## 结论

初审确认 1 项 P2，未发现其他明确 P1/P2。下文保留初审证据；该问题及修补期间发现的三个 P2 已由后续修复关闭，原生 Astra / high 再审无新增明确 P1/P2，见 [修复记录](REPAIR.md)。

## 执行身份与候选

- 原生子代理：`/root/r2_astra_reviewer`，角色 `reviewer`。
- 会话：`01a0dbe7-1910-7303-bee9-8f168921b99f`。
- 初始探测和正式评审两次 turn_context 均核验为 `gpt-6-astra / high`。
- 基线：`af255febcba902a70d16cfec9271dfa2c5cd6ae9`，工作树 `/Users/luo/Documents/github/codex-host-r1`，分支 `codex/upstream-r1`。
- 范围：U05/U06/U08/U12/U16/U17/U18；19 个 R2 文件及相关调用链、合同、测试。候选见 `native-review-candidate.json`，终审前后哈希一致；15 个 R1 基线哈希也一致。
- 排除：U15/CodeBuddy、账号、配额、历史导入、新 Harness。

## Finding

### P2 — U12 终态刷新阻塞输出消费，后续 running 无法及时使旧刷新失效

位置：`packages/host-runtime/src/app-server-host.ts:4698`；串行消费入口 `:4185`。

已打开子线程收到终态后，状态处理同步等待四轮历史刷新。同一输出队列随后收到 running 时，消费者仍阻塞在历史读取，running 尚未被消费，转换 token 无法更新。旧刷新仍可发送完成和 idle 通知；重新打开子线程可能看到过时 idle，父线程后续事件也被延迟。评审代理从真实调用链独立确认该问题。

最小修复：将终态延迟刷新移出串行输出消费链，作为可跟踪、可失效的任务执行；用转换 token 保护结果应用与通知，并处理关闭和异常。补充真实输出队列的“终态 → 阻塞读取 → running → 释放读取”回归。`packages/host-runtime/test/app-server-host.test.ts:833` 的 helper 测试绕过了实际事件消费，不能证明该路径正确。

## 已核实的修复

U05 `external-thread-fork.ts:204` 的 readSnapshot 返回失败现已进入统一清理路径：关闭和临时记录删除失败分别报告，清理成功保留映射错误码；fixture 覆盖两项清理同时失败。此项为静态确认，没有由 reviewer 重跑测试。

## 验证边界

本轮 reviewer 执行测试/构建为 0，没有修改文件、启动 Desktop/Harness、提交或推送。RESULT.md 中既有测试记录属于 owner 报告。本轮父代理执行了候选哈希检查及 git diff --check。

未验证真实权限恢复、Pi 慢工具取消、macOS 锁争用、完整 attachment 启动及 OpenCode 进程树回收。后续已完成 U12 修复及真实输出队列级回归，最终 owner 运行 214 项 Host 测试通过，见 REPAIR.md。

## 代理配置

用户授权新增 `/Users/luo/.codex/agents/astra-code-reviewer.toml`，模型为 Astra / high、只读；当前会话指定该新角色名时返回 unknown agent_type。

为不重启应用，使用已有 `reviewer` 角色：将 `/Users/luo/.codex/agents/reviewer.toml` 的 model 从 gpt-6-sol 改为 gpt-6-astra，保留原有 high 和 read-only。该已知角色成功读取修改，并完成本次原生终审。未恢复已删除的 default.toml，未使用 CLI 执行本轮终审。
