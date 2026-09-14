# Host / Adapter remediation 独立复审

## 范围绑定

- 分支：`codex/full-review-remediation-20260912`
- 基线与当前 `HEAD`：`38964658185bd090b4044f0cc9f5b575d8284b87`
- 实际审查对象：该基线到当前未提交工作区的 diff。目标修复尚未形成 commit，因此不是空的 commit-only range。
- 深入范围：Host `app-server-host`、`external-thread-*`、delegation coordinator/registry、Session validation、mapping-store/protocol-core；Pi/OMP/OpenCode/Kiro；DeepSeek Modern Adapter/Session。
- 排除：Renderer、Claude/Grok/Antigravity/Broker、conformance、native 及其它并行 owner 范围。
- `host.md`、`adapters-b.md` 只作为声明索引；以下结论均回查当前源码和测试。

## Findings

### P1 / confirmed / F18：历史替换操作没有取得共享 reservation，反向时序仍会与 command 并发

**证据：** `packages/host-runtime/src/app-server-host.ts:2777-2818` 只有 command 路径会把 Thread ID 加入/移出 `#pendingExternalCommandRequests`。fork/revert/rollback/delete 在 `:3364-3381`、`:3399-3412`、`:3450-3470`、`:3484-3497`、`:3542-3554` 只执行一次 `has()` 检查，随后直接进入异步操作，自己从未占用该 reservation。

**触发：** 先发起 rollback/revert/fork/delete，使其停在 refresh、`adapter.open()`、Snapshot 读取或 MappingStore 写入；再发 command。后到的 command 在 `:2768-2777` 仍看到 `thread.running=false` 且集合为空，于是可在旧 Session 上 catalog/execute。rollback/delete 随后可能替换或关闭同一 Session；fork 也可能在 command 改写/压缩历史时取边界。

**影响：** command 可在即将被替换或删除的 Native Session 上执行，出现已执行但 Host 丢失、历史派生边界漂移、或两边随机失败。当前 `app-server-host.test.ts:4680-4726` 只覆盖“command 先占位，rollback/delete 后到”的单向时序，没有覆盖反向窗口，因此绿色测试不能关闭 F18。

**最小修复：** 把集合改为通用 per-Thread operation reservation（或复用同一集合），fork/revert/rollback/delete 在第一次异步等待前原子 acquire，在 `finally` release；command 和 turn admission 查询同一 reservation。增加 rollback 与 delete 先阻塞、command 后到并返回 `-32072` 的两条回归。

### P2 / confirmed / F07：一次 applied-but-not-persisted 后，下一次配置成功会从旧 carrier 恢复另一项旧值

**证据：** Thinking 路径能读到完整的 `projected.effectivePermissionModeId`（`packages/host-runtime/src/app-server-host.ts:3024-3036`），但构造 carrier 时只覆盖 model/thinking，permission 继续来自旧 `previousSelection`（`:3041-3051`）。Permission 路径同理读到了 effective thinking（`:3113-3125`），但写 carrier 时只覆盖 model/permission（`:3130-3140`）。持久化失败时 `#persistExternalTransportSelection` 抛错且 `thread.transportModelId` 保持旧值（`:3156-3177`），这是预期的部分失败状态，却使下一次合并必然以旧 carrier 为底。

**触发示例：** durable carrier 为 `thinking=low, permission=auto`；Permission 选择 `default` 已被 Harness 应用，但 MappingStore 写失败。随后 Thinking 选择 `high` 成功；当前代码写成 `thinking=high, permission=auto`，虽然 Session 实际仍是 `permission=default`。反向的 Thinking 部分失败 + Permission 成功也一样。

**影响：** 当前进程展示实际状态，重启后却按错误 carrier 恢复旧配置。若旧值权限更宽，会把用户已经收紧但首次落盘失败的权限在下一次成功配置后重新固化。

**最小修复：** 每次成功确认后，用完整 observed state 覆盖 carrier 中所有已报告配置字段，仅对本次未报告字段回退到 `previousSelection`；同步更新相应 `requested*`。新增“第一次写失败、第二个不同配置写成功、重启/解码读回仍等于实际 Session 全量状态”的回归。

### P2 / confirmed failure-path / F05：finalizer 自身投影失败时不会唤醒 Thread change waiters

**证据：** `#finalizeExternalSessionFailure` 正常走 synthetic `turn.completed` 时会借 `#projectHarnessOutput` bump change hub；但投影抛错的 catch 仅清空 `projectedTurns/responseGates` 并补写 delegation status（`packages/host-runtime/src/app-server-host.ts:4094-4103`）。finally 随后直接从 Runtime 移除并 close Session（`:4104-4109`），没有 `thread.changes.bump()/close()`、`attentionChanges.bump()/close()`，也没有逐个 resolve 后再清空 response gate。`ThreadChangeHub.wait()` 只能靠 bump、close 或 timeout 结束。

**触发：** 输出流结束后 synthetic terminal 在 delegation 持久化或输出写入阶段抛错；此时已经订阅该 Thread 的 `wait`/`wait-many` 仍绑定旧 hub。代码把 Thread 移出 Runtime 后，这些 waiter 不会再收到后续 bump，只能等完整 timeout。

**影响：** 最需要 fail-fast 的双重故障路径仍表现为假 busy/长时间等待，违背 F05 的“状态等待器释放”目标。现有 `app-server-host.test.ts:4733-4809` 只覆盖 terminal 投影成功、一次 close 和随后可 read，没有注入 terminal projection failure。

**最小修复：** 在 finalizer finally（或 `ExternalThreadRuntime.remove` 的统一退休路径）先 resolve 所有 response gate，并 `close()` 两个 ThreadChangeHub，再移除 Runtime；补一条 MappingStore terminal status 写失败时 wait/wait-many 立即收敛的测试。

### P2 / confirmed control-flow, native trigger待实机确认 / F10：OpenCode 取消结果未知且 idle transcript 无 User Message 时 Turn 永久占用

**证据：** abort 抛错会把状态置为 `unknown`（`packages/adapters/opencode/src/opencode-adapter.ts:599-612`）。之后 idle reconciliation 若找不到本 Turn 的 User Message，仅 `confirmed` 会完成为 cancelled；`unknown` 直接 return（`:1177-1187`）。此后没有 timer、fault 或其它收口，`#active` 保留，所有后续 Turn/配置都持续返回 busy。

**触发：** prompt admission 已响应；取消请求到达 native 但响应丢失，native 在 User Message 落盘前结束并报告 idle，或者 reconnect 后 authoritative transcript 不含该 User Message。前半段是当前代码明确承认的 outcome-unknown 场景；目标 OpenCode 版本是否会产生“idle + 无 User Message”组合仍需真实 native 验证。

**影响：** 修复避免了把成功/provider failure误写为 cancelled，但这个分支把 Thread 留成永久 busy，只有关闭/重开 Session 才能恢复。

**最小修复：** 在 authoritative idle 且 lifecycle 已观察、User Message 仍缺失时，对 `unknown` fail closed：发一个 `nativeFailure/processExited` failed terminal，并 fault/close 当前 Session，避免重放也避免继续复用不确定 Session。增加 abort reject + idle + empty transcript 的回归；保留现有 abort reject + successful terminal 测试。

### P2 / confirmed / F22：OMP create Session 的 Subagent capability 来自 Adapter 全局旧探测，不来自该 Session

**证据：** inspect 把本次 transport 的订阅结果写入 Adapter 全局 `#subagentObservationSupported`（`packages/adapters/omp/src/omp-adapter.ts:2206-2244`）；lazy create 不启动自己的 transport，直接把这个全局值冻结进 Session capabilities（`:2279-2322`、`:2492-2507`）。该 Session 首次执行时 transport 才真正发送订阅；成功或 unsupported 都不会更新已创建 Session 的 capabilities。resume/fork/rollback 因先启动 transport，再在 `:2446-2464` 构造 Session，不存在该问题。

**触发：** 未先 inspect 的直接/delegated create 会永久声明 `observe=false`，即使首次 transport 成功订阅。反过来，先前 inspect 成功后 Native 二进制降级、PATH/environment 指向旧版本，再 create，会在实际订阅 unsupported 时仍声明 `observe=true` 和 autonomous Turns。

**影响：** F22 的 capability 真值仍可能与真实 RPC 订阅相反；前者隐藏能力，后者重现“声明可观测但事件不来”的契约错误。现有测试分别证明 RPC 会 probe、旧 native 会降级，但所有 Adapter fake transport 固定 `subagentSubscription="events"`，没有覆盖 create 的 per-Session 关联。

**最小修复：** create 在返回 Session 前以当前 cwd/environment 启动其首个 transport并据其 probe 构造 capabilities，或引入受契约支持的 capability 状态更新；不要复用跨 Session 的单个 boolean。增加 no-inspect create success、inspect-success 后 create-unsupported 两条测试。

## 必补的高风险测试（代码阅读未发现对应覆盖）

1. **F06 restart dedup：** 现有 `mapping-store/test/index.test.ts:1240-1278` 只证明 paired provisional 被保留且 `createDelegatedThread` 返回 reused；应从 `HarnessDelegationCoordinator.start(requestId)` 重试，断言 `adapter.open` 零调用，并得到 `outcomeUnknown=true`。这能直接证明“未知结果不重放”，而不是只证明 Store 记录存在。
2. **F08 Host 全链路：** 为 delegated record 写入 `executionPolicy` 后重启 Host，分别断言 resume/fork/rollback 的 `adapter.open` 都收到同一 policy；旧 record 缺字段时仍省略。当前 Adapter 单测与 MappingStore 单测没有覆盖 Host 组合链。
3. **DeepSeek isolated ownership：** 带不同 `environment` 的两个 child 同时 resume 同一 Native ID，必须只有一个成功、另一个在 native RPC 前 `sessionBusy`；当前 duplicate reservation 测试走共享 root connection，没有覆盖新 child 结构。
4. **DeepSeek 0.1.5 source flush/close race：** source Session 位于一个 isolated child 时，从另一个 environment fork/rollback，断言 source owner `flushSession` 先于 child `session/fork`；再覆盖 root close 与 isolated open 并发，确保不返回已关闭的 Session且每个 connection 只 close 一次。现有 environment 参数化测试使用默认 profile，没有证明 0.1.5 flush 顺序。

## 已验证

- 定向 Vitest：13 个实际测试文件，`492 passed`。覆盖 Host app/session validation、delegation coordinator、external runtime/rollback、MappingStore、Pi/OMP/OpenCode/Kiro、DeepSeek Modern。
- 目标范围 `git diff --check`：通过。
- 未运行：`tsc`、full build、Desktop、真实 Harness/模型、native、用户历史、付费、部署；遵守本轮限制。

## 无阻断发现的已核对部分与残余风险

- OpenCode permission mismatch 会先保存 native 返回的 `updated`、发布 actual effective state，再返回 `protocolError`，当前实现与测试一致。
- Kiro Adapter close 对 opening transport 和已建 Session 的竞态收口成立；unknown create/resume/live permission 均在相应 native 调用前拒绝。
- DeepSeek per-environment child、共享 reservation Set、Session close 后 child connection 回收、resume/fork/rollback permission readback 的代码路径自洽；以上列出的并发/0.1.5 测试仍是发布前必要证明。
- Pi/OMP/OpenCode fault 自动进入幂等 close 的定向测试通过；真实进程树退出、OMP 18.1.18 subscription response、OpenCode outcome-unknown native 组合仍需目标二进制验证。

**建议优先级：** F18 作为合入阻断先修；随后修 F07 与 F05 双重失败路径；F10/F22 至少在真实 native 验收前补定向回归和 fail-closed 收口。F06/F08/DeepSeek 的四项缺测应与对应 owner 修复一并补齐。

---

## 二次收口复审（当前工作区）

本节保留首次 findings 作为审查轨迹；以下处置状态代表当前结论。

### 原 findings 处置

- **F18 已闭合。** `app-server-host.ts:3360-3364` 增加统一原子 reservation；command 在解析/恢复 Thread 前 acquire（`:2761-2769`），fork/revert/rollback/delete 均在首个异步步骤前 acquire 并在 `finally` release（`:3373-3416`、`:3419-3463`、`:3474-3509`、`:3512-3539`、`:3574-3611`）。新增 rollback-first 与 delete-first 反向时序回归，证明后到 command 返回 `-32072`。
- **F07 已闭合。** Thinking 成功确认时把 observed permission 写回 carrier/requested state（`:3027-3063`）；Permission 成功确认时同样带回 observed thinking（`:3122-3158`）。`app-server-host.test.ts:4294` 覆盖首次 permission applied-but-unpersisted、随后 thinking 成功后 durable carrier 保留完整 actual configuration。
- **F05 已闭合。** finalizer finally 逐个 resolve response gates，并关闭 change/attention hubs，再 fault state/steering、移除 Runtime 和 close Session（`:4145-4154`）。`app-server-host.test.ts:5063` 注入 delegation terminal 持久化失败，证明 wait 与 wait-many 在 750ms 内从 1500ms wait 释放。
- **F10 已闭合。** OpenCode 在 cancellation `unknown` + authoritative idle + 缺 User Message 时以 `processExited` fault（`opencode-adapter.ts:1177-1194`）；统一 fault path发 failed terminal、`session.faulted` 并 close owned transport/connection（`:1460-1494`）。新增测试同时证明 terminal 唯一、Session 不再接受后续 Turn、资源 close 一次。
- **F22 原 capability 漂移已闭合。** OMP create 现在启动当前 Session transport，完成 subscription probe、model/thinking reconciliation 与 usage readback后才构造 Session（`omp-adapter.ts:2311-2358`）；capability 不再来自 Adapter 全局缓存。新增 no-inspect success 与 inspect-success/create-unsupported 两条关联回归。

### 首次缺测处置

- **F06 已闭合：** `harness-delegation-coordinator.test.ts:306-370` 从 Coordinator 以同 requestId 重试 paired provisional，断言 `outcomeUnknown=true` 且 `adapter.openInputs` 为空，直接证明 no replay。
- **F08 已闭合：** `app-server-host.test.ts:4875-4994` 覆盖 delegated policy 经 Host fork、rollback、重启 resume 传递；同时证明 legacy record 不推断 policy。
- **DeepSeek shared identity 已闭合：** `deepseek-harness-adapter.test.ts:983-1004` 用两个 environment child 并发 resume 同一 Native ID，只有一个连接并成功，另一个在连接前 `sessionBusy`。
- **DeepSeek isolated close race 已闭合：** root 在 child open 返回后再次 `#assertAccepting()`（`deepseek-harness-adapter.ts:254-261`）；`:1006-1026` 覆盖 root close 与 isolated startup 重叠，不发布关闭后的 Session，所有 connection 只 close 一次。
- **DeepSeek 0.1.5 source flush 已闭合：** `:670-710` 对 fork/rollback 参数化验证 source owner flush 严格先于 derived child fork，并核对所有 Web connection 回收。

### 新发现 · P2 / confirmed：OMP eager create 没有纳入 Adapter.close 的 opening-resource 集合

**证据：** F22 修复后，create 在 `packages/adapters/omp/src/omp-adapter.ts:2311-2349` 创建并启动 transport，但直到 `#trackSession` 才进入 `#sessions`。这段 opening transport 不在 `#inspections`。`Adapter.close()` 在 `:2562-2569` 只快照并等待 `#inspections` 与 `#sessions`，因此 close 与 `transport.start()` 重叠时会对空集合立即 resolve。open 最终在 `:2359-2362` 检测 close 并关闭 Session，但此时 Adapter.close 已经对调用方宣称完成；若 startup/config readback 阻塞，Native 进程仍可在 close 完成后存活至其自身 timeout。

**影响：** Host shutdown/插件卸载可以在 owned OMP process 仍处于启动中时完成资源生命周期；这是 F22 从 lazy create 改为 eager create 后进入普通 create 路径的新窗口。resume/fork 原本也有类似结构，但本 finding 只要求收口本次 F22 直接引入的 create 回归。

**最小修复：** 像 Kiro 一样登记 opening transports/inflight opens；`close()` 先封口、关闭 opening transport，并等待 open 收敛，且 open 不得在 close 后返回成功。增加 deferred `transport.start()` 的 create/close race：close 在 release 前不宣称完成或至少立即关闭 opening transport，最终 open 为 `invalidState`，transport close 恰好一次。

### 二次独立验证

- 当前目标生产与新增测试逐项回读；没有依赖 owner 收据提升证据等级。
- 实际运行 6 个聚焦测试文件：Host app/coordinator、OMP adapter/RPC、OpenCode、DeepSeek Modern，共 **343 passed**。
- 未运行 full build、tsc、Desktop、真实 Harness/native、用户历史、付费或部署。

**当前结论：** 原 5 项 finding 与首次列出的 F06/F08/DeepSeek 缺测均已闭合；剩余合入前代码项只有上述 OMP create/close opening-resource race。真实 OMP 18.1.18 subscription、OpenCode outcome-unknown 组合与 DeepSeek Web 进程行为仍属于目标二进制验收边界。

---

## OMP 最终 P2 收口复审

### 上轮新 P2 已闭合

- create 在任何首个 `await` 前创建并登记 `opening`，transport 创建后立即加入 `#openingTransports`（`packages/adapters/omp/src/omp-adapter.ts:2314-2330`）。因此 close 无法漏掉已开始的 eager create。
- Adapter close 先设置唯一 `#closePromise` 封门，复用 `#closeOpeningTransport` 的 close-once Promise，关闭当前 opening transport/Session 后继续等待创建时登记的 opening Promise 收敛（`:2576-2596`）。
- create 在 native startup/config/usage readback 后、发布 Session 前再次检查 close 状态；close 已开始时返回 `invalidState`，finally 删除 opening 集合并释放 waiter（`:2357-2380`）。close 与 catch 共享同一 transport close Promise，不会重复关闭。
- `omp-adapter.test.ts:654-691` 的 deferred-start 回归覆盖：close 在 startup 释放前不完成、opening 不发布 Session、最终 open 为 `invalidState`、transport close 恰好一次、重复 Adapter close 幂等。

独立验证：

- `omp-adapter.test.ts` + `omp-rpc-session.test.ts`：**2 files，37 passed**。
- OMP 目标 diff `git diff --check`：通过。
- 未运行全局 typecheck；当前外部 Broker/Cursor 编辑错误不用于评价 OMP。

### 非阻断残余已闭合

`#openingTransportCloses` 已改为 `WeakMap<OmpTurnTransport, Promise<void>>`（`packages/adapters/omp/src/omp-adapter.ts:2160`），且仅由 `#closeOpeningTransport` 执行 `get` / `set`（`:2577-2580`），没有迭代、`size` 或其他依赖强引用的逻辑。该机械变更保留并发 close-once 语义，同时允许失败 create 的 transport 在无其他引用后被回收；上轮内存保留残余已关闭。

本轮按要求仅静态复核容器类型与全部使用点，未重跑测试；前轮 OMP 聚焦验证仍为 **2 files，37 passed**。

**最终状态：** 原 5 项 findings、4 组缺测、OMP opening-resource P2 及其最后非阻断残余均已关闭；本范围没有剩余 finding 或合入阻断。目标真实 OMP 18.1.18 的 subscription 与进程树退出仍属既有 native 验收边界。
