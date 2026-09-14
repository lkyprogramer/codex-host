# T02 — 创建原子性、重试与孤立记录恢复

依赖：T01。Owner：Host writer。目标：一个创建请求只产生一个可管理的 child，失败不会留下成功回执无法读取的记录。

## 输入
- /Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/concurrent-idempotency.json、concurrent-recovery.json、concurrent-orphan-read.json。
- packages/host-runtime/src/harness-delegation-coordinator.ts:185、external-thread-repository.ts。
- packages/mapping-store/src/mapping-store.ts 的 createProvisional/createDelegation 与索引更新；records.ts。
- packages/host-runtime/src/delegation-types.ts、delegation-control-{server,registry}.ts、delegation-cli.ts。

## 写边界
上述 owning 文件、它们的直接测试、tools/delegation 的 CREATION/RECOVERY scenarios。不修改其他 Harness 的 native 协议或 Account 分页代码。不清空整个 mapping store、不修现用账号存储。

## 确定合同
- 现有 request-id 的全局唯一语义保留；相同 ID 必须同时匹配 parent、Harness、canonical cwd、task 与请求配置。不同 parent/输入不能误返回另一 child。
- 同 ID 的并发请求合并到同一次 admission/持久化结果，不能只在查询时去重；不同 ID 不被全局串行锁无谓阻塞。
- 无 ID 的现有短窗口去重保持兼容，但不宣称跨窗口 exactly-once。
- 成功结果必须有已投递的真实 thread/turn；未知投递结果保留可管理、明确未证实的状态，禁止用 pending 冒充真实 turn。
- 缺失 external Thread 的 Delegation 仍属于 external；禁止跌入官方 Account 路径报错。

## 实现任务
1. 先在隔离存储用 barrier/fault injection 复现并发 check→write 竞态及 cleanup 误删；测试必须操纵实际 owning methods。
2. 对协调 admission 与存储索引/文件写建立完整原子边界。清理只拥有自己的 provisional 对象，不以共享 request-id 猜测归属。
3. 各持久化切点恢复：Thread provisional、Delegation、native session identity、initial delivery、成功回执；已投递但回执丢失必须读取原结果，不盲重发原 task。
4. 增加受支持的单记录 reconcile：默认 dry-run；apply 只在证明该记录没有活动工作、真实 native 状态已核实后处理。未知 native side effect 保留 UNKNOWN，不自动删除/换 ID。具体错误 enum 沿已有类型扩展，不输出成功 JSON 包住失败。
5. 为已失败可确认未投递的记录定义可重复恢复方式；保留 rollback 所需最小元数据快照，不复制私有 transcript。

## 测试
- CREATION-01：2 个 barrier 并发同 ID，只启动/投递一次，两个调用得到一致的可读取 identity。
- CREATION-02：同 ID 不同 task/cwd/model/parent 各拒绝；不同 ID 两任务允许并行。
- CREATION-03：逐持久化切点注入异常，rollback 不破坏赢家；重试不留 inaccessible creating。
- RECOVERY-01：重新打开隔离 MappingStore/Runtime，已投递请求不二次投递；无 native 对象的残留给出可诊断结果。
- RECOVERY-02：reconcile dry-run 零写；apply 幂等，活动/UNKNOWN 拒绝，旧合法记录可加载。
- 每类 hermetic 通过后，真实 Grok 用两个并发同 ID 的无副作用短任务校准一次。不要在现用 Host 再制造孤立记录。

命令：npx --no-install vitest run --config tests/vitest.config.js packages/mapping-store/test/index.test.ts packages/host-runtime/test/harness-delegation-coordinator.test.ts packages/host-runtime/test/external-thread-repository.test.ts packages/host-runtime/test/delegation-control-registry.test.ts packages/host-runtime/test/delegation-control-server.test.ts。
live：verify.mjs --mode live --scenario CREATION-01,RECOVERY-01。

## 完成
原始双失败复现变成一次真实投递、一份稳定结果；无不可管理记录。旧孤立 67308aba-8ce7-48ca-9ca8-eb6da79638f6 只保留为恢复参考，实际现用数据修理不在本 task 授权内。

