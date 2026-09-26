# R2 终审问题修复

工作树 `/Users/luo/Documents/github/codex-host-r1`，分支 `codex/upstream-r1`，HEAD `af255febcba902a70d16cfec9271dfa2c5cd6ae9`。不提交、不推送、不启动 Desktop 或原生 Harness。

## 修复范围

| 问题 | 修复 | 行为证据 |
| --- | --- | --- |
| U12 终态历史刷新阻塞串行输出队列 | 终态刷新作为可跟踪任务执行；队列只等待即时状态处理；任务计入 graceful drain，在状态转换/Host 关闭时取消 | 真实输出队列中 native read 阻塞时 running 和父线程后续事件仍被消费 |
| ABA 旧读取超过刷新窗口，新终态丢失结果 | 新一代在自身取消信号及既有 read/restore 期限内等待旧 native operation 退出，再开始新读取；保留单一在途读取 | 旧读取阻塞 400 ms（超过原四轮延迟总和 300 ms），释放后仍投影新的终态历史；等待取消/超时单测确认无并发读取 |
| 取消发生在映射提交期间，内存与磁盘身份分裂 | alignSnapshot 完成后接纳已提交且不旧于当前的 record revision；失效 snapshot 仍不能更新 turns 或通知 | beforeReplace 阻塞新增 Native Turn 映射提交，在此期间 running→idle，释放后最终刷新成功且 Host Turn ID 稳定 |
| 输出背压后旧完成通知泄漏 | item/started await 后检查有效性；OrderedWriter 对可失效通知在真正出队写入前再次检查 | 控制 item/started 背压，在 running 或 shutdown 后释放，不再产生旧 item/completed |

改动文件：
- `packages/host-runtime/src/app-server-host.ts`
- `packages/host-runtime/src/external-thread-runtime.ts`
- `packages/host-runtime/test/app-server-host.test.ts`
- `packages/host-runtime/test/external-thread-runtime.test.ts`

没有修改其他 R2 实现、R1 实现或 CodeBuddy。

## 验证

使用 Node 22.22.0，并移除 NODE_USE_ENV_PROXY 环境变量：

```bash
npx vitest run --config tests/vitest.config.js \
  packages/host-runtime/test/app-server-host.test.ts \
  packages/host-runtime/test/external-thread-runtime.test.ts \
  packages/host-runtime/test/managed-harness-session.test.ts
npm run typecheck
npm run lint
git diff --check
```

- 初始真实队列三场景修复前均失败，确认串行等待/关闭问题。
- 第一轮修补复核发现三个 P2；延后读取、磁盘提交、背压 running、背压 shutdown 四个强化场景在第二轮修复前均失败。
- 最终队列六场景全部通过；完整三个 Host 测试文件 214 passed。
- lint 通过（含包边界）；最终 typecheck 和 diff 检查也通过。
- 关闭测试采用现有可配置关闭预算 100 ms，验证在不可取消 native read 下有界退出；不宣称原生操作已强制终止。

## 独立复核

原生 reviewer 会话 `01a0dbe7-1910-7303-bee9-8f168921b99f`，各次 turn_context 核验为 `gpt-6-astra / high`。修补候选哈希见 `repair-review-candidate.json`。第二轮修补终审已完成：原 U12 队列阻塞与后续三个 P2 均已关闭，无新增明确 P1/P2。评审代理只读，没有自行执行测试；214/214、typecheck、lint 等为主代理实际执行结果。19 个候选文件及 15 个 R1 文件哈希全部一致。

## 未覆盖边界

没有运行真实 Harness/模型、真实 Desktop attachment、SSH、Windows/Linux、全仓测试、安装/升级或发布。原生历史删除合同及已有 stale-lock 协议边界沿用 RESULT.md，不宣称本轮解决了它们。
