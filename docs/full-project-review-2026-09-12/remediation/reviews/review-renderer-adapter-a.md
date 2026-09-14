# Renderer / Desktop / Adapter A / Broker 独立只读复审

## 结论与范围绑定

复审对象是 `/Users/luo/Documents/github/codex-host` 当前工作树；分支为 `codex/full-review-remediation-20260912`，`HEAD` 与基线均为 `38964658185bd090b4044f0cc9f5b575d8284b87`。因此本轮审查的是该基线到未提交工作树（含未跟踪测试），不是已提交 commit range。

覆盖范围：`packages/renderer-extension/src` 相关改动、Renderer 单测与合成 E2E、`packages/desktop-control/src` 及测试；Claude Code、Grok、Antigravity 和 Harness Broker 的 production diff 与对应故障路径测试。Host Runtime 仅读取 `session.faulted` 消费入口来确认 Broker 集成语义，没有复审其他 owner 的 Host 改动。

**独立结论：修后未发现范围内仍成立的 P0–P3 生产缺陷。** 初审确认的 Renderer 默认 Codex 阻断、同 ID Sidebar 展示陈旧、Broker auth fault 不可恢复、Grok provisional fork 泄漏、Antigravity brain-only/cleanup reject 均已由当前源码和定向测试闭合。F14、F23、F01、F02、F03、F12 的目标行为从静态调用链与当前测试证据看成立。

## 初审 findings 的最终复核

### 已闭合 P1 · Renderer 默认 Codex 输入/提交与 external→Codex carrier 清理

- **原触发与影响：** 默认 Codex draft 的 `beforeinput`、Enter、click 会被 capture handler 阻断；从 external Harness 切回 Codex 时旧 carrier 不会清除。
- **当前生产证据：** `packages/renderer-extension/src/renderer-binding-probe.ts:585-588` 现在允许 Codex 与任意合法 Harness ID 进入同一 carrier policy；Agent 切换在 `:1925-1951` 对 Codex 也调用 `applyAdapterAgent`，提交前写入在 `:2656-2678` 使用相同规则。Codex 的 model/thinking/permission 仍为空，因此 policy 获得 Codex/null 语义并清除 external override。
- **回归证据：** `tests/e2e/renderer-dynamic-plugin.spec.ts:107-164` 实际派发可取消的 `beforeinput`、Enter 与 click，三者均未被阻断；随后切换 unknown fixed-model Harness，再切回 Codex并观察到 Codex policy 写入。Renderer 两个定向测试文件 58/58，合成 Playwright 1/1。
- **风险降低：** 恢复官方 Codex 默认正常路径，同时保留无 Model external Harness 的 generic carrier。

### 已闭合 P3 · 同一 Harness ID 的 manifest name/icon 不刷新 Sidebar

- **原触发与影响：** 插件升级或 Host 切换时 Harness ID 相同但 name/icon 不同，Sidebar 复用旧 marker，导致 icon、title 与 aria-label 陈旧。
- **当前生产证据：** `packages/renderer-extension/src/renderer-sidebar-agent-icons.ts:36-51` 用 name+icon 生成 presentation fingerprint；`:180-214` 仅在 agent 与 fingerprint 都相同时复用，否则重建 marker、label 与 icon。
- **回归证据：** `packages/renderer-extension/test/renderer-sidebar-agent-icons.test.ts:159-192` 分别改变同 ID 的 name 与 icon，均断言不能复用旧 marker。
- **风险降低：** Sidebar 展示随目标 Host 的 plugin directory 刷新，路由身份与可视身份保持一致。

### 已闭合 P1 · Broker authentication terminal 未产生 Session fault/fresh resume

- **原触发与影响：** native Turn 以 `authenticationRequired` 失败后，Broker 仅把旧 wrapper 设为内部 faulted；Host 看不到 Session fault，旧 Thread 永久拒绝命令，fresh resume 没有生产入口。
- **当前生产证据：** Server 在 `packages/harness-broker/src/server.ts:392-421` 先转发失败 Turn，再发送携带同一 authentication error 的 `session.faulted`，关闭 native Session 并停止 forwarder。Client 在 `packages/harness-broker/src/client.ts:426-465` 保证唯一 Session terminal、结束 output channel并忽略迟到输出；`:505-525` 让旧 wrapper fail closed，显式 close 后才释放。
- **回归证据：** `packages/harness-broker/test/harness-broker.test.ts:752-803` 验证顺序为 failed Turn → 唯一 `session.faulted` → iterator done；旧 wrapper 不重开，close 后新的 `adapter.open(kind: "resume")` 精确调用一次并保留 nativeRef。新增 `packages/host-runtime/test/broker-host-fault-recovery.test.ts:82-227` 使用真实 Broker server/client 与 `AppServerHost` 组合，进一步验证 Host 只完成一次失败 Turn、旧 wrapper close once、同 Thread 下一次 `turn/start` 精确打开一个保留 nativeRef 的 fresh resume，并成功完成恢复 Turn。
- **风险降低：** Host 可先完成失败 Turn，再按既有 Session fault 路径移除旧 wrapper；恢复使用新的 resume Session，不再复活已经终止的对象。

### 已闭合 P2 · Grok fork 成功、load 失败时泄漏派生 Native Session

- **原触发与影响：** ACP fork 已返回 derived ID，但随后 `session/load` 失败；Adapter 尚未取得该 ID，无法 cleanup，重复失败会留下含源历史的孤儿 Session。
- **当前生产证据：** `packages/adapters/grok/src/acp-transport.ts:187-215` 将 provisional cleanup 放在最早拥有 derived ID 和连接的 transport 层；`:714-745` 的 fork/load 路径用该 helper，并向 `session/delete` 精确传递 `forked.newSessionId`。delete 失败时保留 typed `GrokTransportError` 与 cleanup diagnostic，不伪报已删除。
- **回归证据：** `packages/adapters/grok/test/acp-fork-cleanup.test.ts:5-53` 覆盖 load 失败时派生 ID 精确删除一次、source history 不变，以及 load+delete 双失败的 typed diagnostic。
- **风险降低：** 消除可清理路径上的 orphan；无法清理时提供明确诊断而不改变源 Session。

### 已闭合 P2 · Antigravity brain-only 成功与 malformed summary cleanup rejection

- **原触发与影响：** source DB 缺失但 brain 存在时可能返回成功并丢失原生上下文；summary schema 损坏时 cleanup 会反向 reject，覆盖本应返回的 typed native failure。
- **当前生产证据：** `packages/adapters/antigravity/src/fork.ts:268-292` 只有 DB 与 brain 都不存在才允许 sidecar-only；brain-only 返回 false。Native DB、brain、summary cleanup 在 `:214-250` 使用 `Promise.allSettled` 收集诊断；fork 在 `:423-448`、rollback 在 `packages/adapters/antigravity/src/rollback.ts:134-159` 都将诊断附加到 `nativeFailure`，cleanup 不再覆盖主失败。
- **回归证据：** `packages/adapters/antigravity/test/fork.test.ts:408-436` 验证 brain-only fail closed、源 brain 不变且无 derived brain；`:438-542` 验证缺少 `conversation_summaries` 表时公共 fork 返回 typed `nativeFailure`、源 cascade ID 不变且无 derived DB 残留。fork/rollback 共用的 cleanup 与 clone helper均在 7 文件定向测试中通过。
- **风险降低：** 不再把不完整 native clone 报为成功；schema 漂移仍可诊断且不会把公共 HarnessResult 变成 rejected Promise。

## 其余目标行为复核

- **F14 精确 unsupported fallback：** `renderer-external-steering.ts` 只对 `RendererMethodUnavailableError` 使用同一 manager 的 stock `thread/read`；`renderer-request-sender.ts` 仅把明确 `-32601` 和指定 method 的 `-32600 unknown variant` 归一为 unavailable，其余错误 fail closed。
- **F23 Host 切换 relay：** `renderer-model-client.ts` 先解绑旧 client、递增 generation并过滤旧回调；binding probe 再按 mounted Host/Thread ID 应用，同 Thread ID 的 A→B 测试通过。
- **旧 Host plugin directory 兼容：** `renderer-binding-probe.ts:2149-2176` 仅在 `listHarnessPlugins` 缺失、返回空能力或抛出精确 `RendererMethodUnavailableError` 时切到 legacy Agent 集；其他目录错误继续 fail closed，不会被伪装成旧 Host。后续 availability inspection 使用该 Host 的目录集合。
- **受限 localStorage：** `renderer-transcript-dom.ts:8-25` 以 `WeakMap<Window, boolean>` 保存当前 Window 的 session fallback；读写 `localStorage` 抛 `SecurityError` 时仍能切换 soft-wrap 并派发同一变更事件，不跨 Window 共享。
- **Model/Thinking 菜单：** `renderer-model-picker.ts:432-440` 在没有可展示 Thinking section 时直开独立 Model menu；`:471-483` 选择 Model 后关闭子菜单并保留父菜单，等待新 Model 的 Thinking options；`:650-689` 在刷新后没有 Thinking section 时关闭冗余父菜单。E2E 覆盖 portal、选择中禁用、Thinking options 刷新与无 Thinking 直开 Model。
- **Cursor thinking 隔离：** per-Agent configuration map 保持 Cursor 与 Kiro 的 model/thinking 独立；`renderer-extension/test/cursor-selection.test.ts:14-54` 证明 Cursor carrier 不带 Kiro thinking，恢复 ownership 也不产生 thinkingOptionId。
- **F01 Claude sources：** execution query 不再限制 `settingSources`；Inspector 的 user-only 隔离仍保留在只读探测路径。
- **F02 Grok rollback：** 通过 fork 建立新 identity，校验源快照不变与派生精确前缀；provisional load failure cleanup 已按上项闭合。
- **F03 Antigravity native fork/rollback：** SQLite、brain、summary 和 sidecar 失败统一 fail closed并清理；source readback 保持不变。
- **F12 Grok background child：** 父 Turn 成功结束后保留 background child；child idle completion 只发独立 subagent state/transcript 事件，不改写已完成父 Turn。

## 实际验证

- Renderer：`npx vitest run --config tests/vitest.config.js --maxWorkers=2 packages/renderer-extension/test/renderer-binding-probe.test.ts packages/renderer-extension/test/renderer-sidebar-agent-icons.test.ts`：**2 files，58 passed**。
- Renderer E2E：`CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npx playwright test tests/e2e/renderer-dynamic-plugin.spec.ts --config tests/e2e/playwright.config.js --workers=1`：**1 passed**。
- Adapter A/Broker：定向运行 Broker 2 个、Grok 2 个、Antigravity 3 个测试文件：**7 files，133 passed**。
- `git diff --check`（本复审范围）：通过，无 whitespace error。

Renderer owner 另报告最终稳定树定向 Vitest **4 files，25 passed**、Model startup **7 passed**。Root 随后运行最终单一全 E2E：**73 passed（35.3s）**，原始日志为 `/tmp/codexhost-remediation-20260912/integration-e2e.log`。本复审代理未重复运行这三组，因此把它们作为 owner/controller 验证证据，不计入上面的独立执行结果。

Root 又补强 `tests/e2e/renderer-dynamic-plugin.spec.ts:165-188`：选中 unknown fixed-model Harness 后，对真实 Composer 分别派发 Enter、click 与 `SubmitEvent`，三者均未被阻断，且最后 carrier 仍为 `future-harness`。该单项 E2E **1 passed**，原始日志为 `/tmp/codexhost-remediation-20260912/integration-dynamic-submit-2.log`。

Host owner 新增 `packages/host-runtime/test/broker-host-fault-recovery.test.ts` 的真实 Host+Broker 组合用例：**1 passed**，且定向 ESLint/format 通过；本复审代理只读核对了完整测试控制流，未与 owner/root 并发重跑。

未启动真实 Codex Desktop、Claude/Grok/agy CLI，未写用户历史或原生数据库，未运行全仓 build/typecheck/lint。Controller 报告全仓 typecheck 已通过，但本复审代理未独立执行，因此不把它计入上述验证。

## 最小仍需补强的证据

本地可补齐的单元、合成 E2E 与 Host+Broker 整链证据均已闭合。唯一剩余边界是目标版本真实环境 smoke：Desktop 私有 DOM/Fiber/CDP 与 Host 切换、真实 Grok ACP 的 fork/load/delete 错误形态、Antigravity 当前 SQLite/brain/summary schema。该 live 验证按本轮约束不运行；未取得这些证据前，不把本报告提升为真实生产运行时验收。

## 剩余风险

剩余风险集中在外部私有接口和真实版本 schema，而不是当前已确认的源码缺陷：Codex Desktop 私有 Renderer binding 可能随版本漂移；Grok ACP 对 delete 与 load 的错误/超时语义需真实 CLI 证明；Antigravity summary/brain schema 需目标版本证明。当前可审查源码、合成交互和故障注入范围内，无新的 blocking finding。
