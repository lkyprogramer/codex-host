# 全项目评审整改结果

原评审的 **29 项 finding（F01–F29）和 7 项架构改造（A01–A07）已完成本地修复与验证**。实施过程中发现的直接回归和验收驱动缺陷也已处理。这里的完成是代码、合同、测试与文档收口，不代表真实 Harness、安装态 Desktop 或各平台部署已经验收。

- 基线分支：`local/all-fixes`；基线与当前提交 HEAD：`38964658185bd090b4044f0cc9f5b575d8284b87`。
- 工作分支：`codex/full-review-remediation-20260912`；全部修改仍在本地工作区，未提交、推送、安装或部署。
- 逐项状态：[status.json](status.json)；最终源码/测试/文档文件指纹：[tree-manifest.json](evidence/tree-manifest.json)。
- [原始全面评审](../README.md)保留为历史快照。既存 `docs/codexhost-grok-delegation-20260910/` 未纳入改动。

## 修复清单

| 编号 | 最终行为 | 主要实现与证明 |
| --- | --- | --- |
| F01 | Claude 执行 Query 恢复 SDK 默认 user/project/local settings；只读检查仍隔离。 | [实现](../../../packages/adapters/claude-code/src/sdk-transport.ts) / [回归](../../../packages/adapters/claude-code/test/sdk-transport.test.ts) |
| F02 | Grok rollback 先原生 fork，校验新 ID、源不变与精确前缀；load 或后续设置失败清理派生 Session。 | [实现](../../../packages/adapters/grok/src/grok-rewind.ts) / [回归](../../../packages/adapters/grok/test/acp-fork-cleanup.test.ts) |
| F03 | Antigravity 按实际 HOME 克隆/裁剪/读回 DB、brain、summary；畸形或不完整原生状态失败关闭，派生失败清理且保持源。 | [实现](../../../packages/adapters/antigravity/src/fork.ts) / [回归](../../../packages/adapters/antigravity/test/fork.test.ts) |
| F04 | Kiro 未知权限值在任何原生副作用前返回 invalidRequest，不映射为 autopilot。 | [实现](../../../packages/adapters/kiro-cli/src/permission-modes.ts) / [回归](../../../packages/adapters/kiro-cli/test/models-and-commands.test.ts) |
| F05 | Host 集中终结输出异常，释放 Turn、response gate、change/attention waiter 并关闭 Session；终结本身失败也收敛。 | [实现](../../../packages/host-runtime/src/app-server-host.ts) / [回归](../../../packages/host-runtime/test/app-server-host.test.ts) |
| F06 | 恢复时保留成对 provisional Thread/委派去重记录；相同 requestId 返回 outcomeUnknown，不重新执行。 | [实现](../../../packages/mapping-store/src/mapping-store.ts) / [回归](../../../packages/host-runtime/test/harness-delegation-coordinator.test.ts) |
| F07 | Model/Thinking/Permission 以原生完整 observed state 更新 carrier 和持久化；写入失败明确报错，后续成功不复活旧配置。 | [实现](../../../packages/host-runtime/src/app-server-host.ts) / [回归](../../../packages/host-runtime/test/app-server-host.test.ts) |
| F08 | executionPolicy 作为 Thread 意图持久化并传递 create/resume/fork/rollback；显式权限优先，旧记录不推断提升权限。 | [实现](../../../packages/harness-adapter/src/text-session.ts) / [回归](../../../packages/host-runtime/test/app-server-host.test.ts) |
| F09 | OMP 恢复/派生首个 transport 接收本次 Thread environment。 | [实现](../../../packages/adapters/omp/src/omp-adapter.ts) / [回归](../../../packages/adapters/omp/test/omp-adapter.test.ts) |
| F10 | OpenCode 取消区分请求成功/失败/结果未知，保留真实 Turn 终态；未知结果且 authoritative idle 无消息时 fault/close。 | [实现](../../../packages/adapters/opencode/src/opencode-adapter.ts) / [回归](../../../packages/adapters/opencode/test/opencode-adapter.test.ts) |
| F11 | OpenCode 权限写入后回读不匹配时公布实际值并返回协议错误，不保留错误的旧公开状态。 | [实现](../../../packages/adapters/opencode/src/opencode-adapter.ts) / [回归](../../../packages/adapters/opencode/test/opencode-adapter.test.ts) |
| F12 | Grok 父 Turn 结束后仍接收后台 child 更新，发布独立 subagent 事件，不改写父轮终态。 | [实现](../../../packages/adapters/grok/src/grok-subagent-lifecycle.ts) / [回归](../../../packages/adapters/grok/test/grok-adapter.test.ts) |
| F13 | native steering/work mode 从实际 Session 能力投影，移除按 Grok 名称猜测能力。 | [实现](../../../packages/shared-contracts/src/harness-models.ts) / [回归](../../../packages/host-runtime/test/external-work-mode.test.ts) |
| F14 | 仅明确扩展 RPC unavailable 时，在同一连接证明官方 Thread 身份后透传 Codex steer；其他错误不降级。 | [实现](../../../packages/renderer-extension/src/renderer-external-steering.ts) / [回归](../../../packages/renderer-extension/test/renderer-external-steering.test.ts) |
| F15 | Pi/OMP/OpenCode fault 收口自动幂等关闭原生 transport/connection。 | [实现](../../../packages/adapters/pi/src/pi-adapter.ts) / [回归](../../../packages/adapters/pi/test/pi-adapter.test.ts) |
| F16 | Kiro cancel 校验活动 Turn ID；通知发送失败返回错误，不声称已受理。 | [实现](../../../packages/adapters/kiro-cli/src/kiro-adapter.ts) / [回归](../../../packages/adapters/kiro-cli/test/kiro-adapter.test.ts) |
| F17 | Kiro close 封闭入口并追踪 opening/active 资源，关闭后拒绝 inspect/open，不发布已关闭 Session。 | [实现](../../../packages/adapters/kiro-cli/src/kiro-adapter.ts) / [回归](../../../packages/adapters/kiro-cli/test/kiro-adapter.test.ts) |
| F18 | command、fork/revert/rollback/delete 共享 per-Thread reservation，在首个 await 前取得并在 finally 释放，覆盖双向竞态。 | [实现](../../../packages/host-runtime/src/app-server-host.ts) / [回归](../../../packages/host-runtime/test/app-server-host.test.ts) |
| F19 | 外部 Turn 输入含未支持非文本部分时明确拒绝，不再悄悄丢弃图像后执行文本。 | [实现](../../../packages/host-runtime/src/app-server-host.ts) / [回归](../../../packages/host-runtime/test/app-server-host.test.ts) |
| F20 | 跨 Runtime 委派列表要求明确 parent scope，不再截断后返回无法继续翻页的结果。 | [实现](../../../packages/host-runtime/src/delegation-control-registry.ts) / [回归](../../../packages/host-runtime/test/delegation-control-registry.test.ts) |
| F21 | 委派 start 返回当前已持久化状态，快速完成不再固定返回 running。 | [实现](../../../packages/host-runtime/src/harness-delegation-coordinator.ts) / [回归](../../../packages/host-runtime/test/harness-delegation-coordinator.test.ts) |
| F22 | OMP 当前 Session transport 显式探测/订阅 subagent；create eager 确认能力，兼容不支持版本，opening 资源纳入 close-once。 | [实现](../../../packages/adapters/omp/src/omp-rpc-session.ts) / [回归](../../../packages/adapters/omp/test/omp-rpc-session.test.ts) |
| F23 | Usage relay 在 client/Host 更换时解绑重订阅，按 generation 与 Host/Thread 身份过滤旧回调。 | [实现](../../../packages/renderer-extension/src/renderer-model-client.ts) / [回归](../../../packages/renderer-extension/test/renderer-model-client.test.ts) |
| F24 | DeepSeek 每次带 environment 的 open 创建独立 managed Web；共享 Native ID reservation、按源 owner flush、close 等待子资源。 | [实现](../../../packages/adapters/deepseek-harness/src/modern/deepseek-harness-adapter.ts) / [回归](../../../packages/adapters/deepseek-harness/test/modern/deepseek-harness-adapter.test.ts) |
| F25 | TS 与 Rust 都从实际 runtime descriptor 同级目录推导 updates 状态路径。 | [实现](../../../packages/update-manager/src/distribution.ts) / [回归](../../../packages/update-manager/test/distribution.test.ts) |
| F26 | Unix Shim 保留信号退出约定 128+signal，正常 stdin EOF 仍为零。 | [实现](../../../crates/shim/src/lib.rs) / [回归](../../../crates/shim/tests/proxy.rs) |
| F27 | remote uninstall 先验证并停止 managed listener，再删除文件；degraded 安装仍可安全 stop，stock/unknown 拒绝。 | [实现](../../../packages/host-runtime/src/remote-host-cli.ts) / [回归](../../../packages/host-runtime/test/remote-host-cli.test.ts) |
| F28 | Artifact 下载总时限与空闲时限通过 AbortSignal 取消；清理 partial、持久化失败并释放更新锁。 | [实现](../../../packages/update-manager/src/update-manager.ts) / [回归](../../../packages/host-runtime/test/update-coordinator.test.ts) |
| F29 | macOS Broker 升级失败恢复已验证旧 plist/generation；恢复必须读到新 descriptor 指纹，双重失败保留诊断。 | [实现](../../../crates/platform/src/macos_native_harness_broker.rs) / [回归](../../../crates/platform/src/macos_native_harness_broker.rs) |

## 架构改造

| 编号 | 已落地的边界 | 主要入口 |
| --- | --- | --- |
| A01 | 目标 Host manifest 目录驱动 Picker、图标、Sidebar、偏好和 HarnessId 配置映射；新 route 统一写，旧 route 兼容读。 | [主要入口](../../../packages/renderer-extension/src/agent-selection-state.ts) |
| A02 | turnControl 明确 native/restart 与 workModes；空 Model catalog 的固定模型 Harness 使用无 Model carrier，并保持官方 Codex 提交。 | [主要入口](../../../packages/shared-contracts/src/harness-models.ts) |
| A03 | 公共 Session validator 与 Host 有期限的拒绝清理；十个真实 Adapter fixture 消费公共 conformance driver。 | [主要入口](../../../packages/harness-adapter/src/session-validation.ts) |
| A04 | Host 统一 reservation、配置提交、未知结果恢复和异常终结；Adapter 保留 native clone/readback/stop/close；Broker fault 后 fresh resume。 | [主要入口](../../../packages/host-runtime/src/app-server-host.ts) |
| A05 | Conformance 收据记录 Host/Bundle/native version/profile、身份、环境、逐场景和资源清理；未知或未覆盖结果不能伪装完整通过。 | [主要入口](../../../packages/harness-adapter/src/conformance-receipt.ts) |
| A06 | 每插件独立声明运行依赖；Bundle 构建收据记录版本、许可、Node target、SHA 与 API v1 政策，发行白名单携带收据。 | [主要入口](../../../scripts/release/harness-plugins.json) |
| A07 | 边界门禁覆盖 package dependencies、tsconfig references/paths；更新当前十个 Harness 接入文档与 skill，保留 native 差异。 | [主要入口](../../../tools/check-boundaries.mjs) |

目录现在负责 Harness 身份和展示，运行时 inspection/Session 负责真实能力与有效配置；Renderer 按 Harness ID 保存草稿，通过共享 route 传递选择。Host 负责协议投影、操作占位、持久化与恢复决策；Adapter 负责原生协议、历史和资源。Rust 继续拥有启动、进程、更新和平台集成，没有把 Harness 语义下沉到 Native。

统一的是可调用合同与可观察结果。Claude SDK、ACP、JSONL RPC、OpenCode server、DeepSeek managed Web、Antigravity Hook/SQLite/brain 仍由各 Adapter 分别实现。Pi 不伪造权限档位，Grok 的 at-create 权限、OpenCode 的 same-cwd、CodeBuddy/Cursor 不支持的派生操作都保留原生限制。

现有 API v1 继续精确版本匹配。新增 `executionPolicy` 和 `turnControl` 为加性字段；旧记录不推断无人值守意图，旧插件缺少 `turnControl` 时保留已有可选接口兼容。新配置写入统一使用 plugin-v1，历史专用 route 保留读取。独立插件市场、热替换和自动依赖安装不属于这次改造，也没有被引入。

## 独立复审补充修复

分区实现后由独立 Sol high 评审复核，再由主代理整合验证。复审报告保留发现与关闭过程，以各报告最后的收口结论为准：

- [Host、Pi/OMP/OpenCode/Kiro、DeepSeek](reviews/review-host-adapters.md)：双向 command/history reservation；部分配置落盘失败后的完整 carrier；finalizer 失败的等待器释放；OpenCode unknown-cancel 收口；OMP 当前 transport 能力与 opening-close；DeepSeek 双环境 Native ID、关闭竞态和 0.1.5 source flush。
- [Renderer、Claude/Grok/Antigravity、Broker](reviews/review-renderer-adapter-a.md)：默认 Codex 输入/Enter/发送被阻止的回归；外部切回 Codex 清除旧 carrier；同 ID manifest 名称/图标刷新；Broker auth 唯一 fault 与 fresh resume；Grok fork-success/load-failure 清理；Antigravity brain-only 与异常 summary 的 typed failure。
- [Native、公共合同、发行与 conformance](reviews/review-native-contracts.md)：旧 Broker 恢复不得接受失败 generation 的 stale descriptor；degraded remote install 可安全停止；坏 Session 的 close 期限和唯一诊断；conformance 完整性、调用期限、迟到资源清理、唯一 terminal、身份和 isolated 输出终结。
- Renderer 的收口还修复了旧 Host 缺目录接口时的兼容、受限 localStorage 的逐 Window fallback，以及 Model/Thinking 菜单刷新；补强了未知固定模型 Harness 的 Enter/click/submit 实际事件。
- 主代理还修复了合法小数 `outputTokensPerSecond` 被整数校验拒绝的问题；conformance 测试迁回 CodeBuddy 自己的包，通过公共入口消费，不反向引用 Adapter 私有源码。
- 全仓 Rust 验证发现 macOS `lsof` 查询一次耗时 19,164 ms，而快照/身份匹配只需数毫秒。查询增加 Unix socket 筛选 `-U`，保留 current UID、精确路径与后续进程身份验证；原两秒断言未放宽，原失败用例修后 1.42 秒通过。

## 验证结果

所有命令在本分支工作区运行，Node 为 22.22.0，Rust/Cargo 为 1.97.1。TypeScript/Vitest 验证显式使用 `NODE_USE_ENV_PROXY=0`，避免当前机器代理注入的 Node 启动警告污染需要严格 stderr 合同的 fixture；没有修改或放松 stderr 断言。浏览器测试使用已安装的 Google Chrome，运行合成页面，没有启动 Codex Desktop。

| 实际命令 | 最终结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 通过（Workspace + tests） | [证据](evidence/typecheck.log) |
| `npm run lint` | 通过（ESLint + dependency/source boundaries） | [证据](evidence/lint.log) |
| `npm run test:typescript -- --maxWorkers=2` | 307 文件通过；3771 passed、22 skipped；包含 TS 与十插件构建 | [证据](evidence/typescript-tests.log) |
| `npm run build:renderer` | 通过（最终 Renderer 产物） | [证据](evidence/build-renderer.log) |
| `npm run test:e2e -- --workers=2` | 73 passed（系统 Chrome） | [证据](evidence/e2e.log) |
| `playwright test tests/e2e/renderer-dynamic-plugin.spec.ts --config tests/e2e/playwright.config.js --workers=1` | 增补 unknown Harness 实际提交回归 1 passed | [证据](evidence/dynamic-submit.log) |
| `npm run test:rust -- -- --test-threads=1` | 完整工作区 172 passed、0 failed | [证据](evidence/rust-tests.log) |
| `cargo fmt --all --check` | 通过 | [证据](evidence/rust-format.log) |
| `cargo clippy --workspace --all-targets --locked --features codexhost-shim/test-utils,codexhost-gate-a-native/gate-tools -- -D warnings` | 通过，无 warning | [证据](evidence/clippy.log) |
| `prettier --check <本次修改的138个文件>` | 通过；另有最终文档格式检查 | [证据](evidence/format.log) |
| `git diff --check` | 通过 | [证据](evidence/diff-check.log) |

最终 TypeScript 用例：**3771 passed、0 failed、22 skipped**。跳过项来自需要显式启用的真实 Harness/Provider 测试及非当前平台的 Windows 用例，未记作通过。Rust 工作区 **172 passed、0 failed**，包含此前 fail-fast 后尚未执行的 updater 和文档测试阶段。

首轮并非全绿：TypeScript 13 项失败中，五项由继承的代理警告造成；其余分别是 Loader 包装后的类名断言、Renderer Host catalog 与配置夹具合同问题。浏览器首先在旧夹具缺 SVG loader 时无法收集，随后按真实菜单 portal、能力和 Host 身份修正夹具。Rust 原 listener 用例在并行和串行均失败后才进行 profiling，并修复实际查询瓶颈。最终结果来自修复后的执行，不用重试次数或改变断言掩盖失败。

## 十个 Harness 的一致性证据

十个实际 Adapter 均消费 `@codexhost/harness-adapter/conformance`，覆盖 inspection、独立环境、create、真实 fixture Turn、并发拒绝、cancel、终态/身份读回、fresh Adapter resume、follow-up 和资源关闭。具体入口见[一致性验证文档](../../../docs/adapter-conformance.md)。

验证驱动现在为 Adapter factory、inspect/open/execute/snapshot、能力回调和 cleanup 设置期限；对迟到的 open 结果继续清理。输出观察器拒绝重复终态和错 Harness/Native Session 的终态，并观察 primary、isolated、resumed 的输出结束。

**核心生命周期测试通过不等于全能力认证。** 收据保留每个场景的 `passed/skipped/notCovered/failed`；顶层只在全部适用证据完成时为 `passed`，未覆盖能力或缺原生清理证据为 `incomplete`，错误为 `failed`。当前 fixture 未完整执行所有 Harness 的 fork/rollback/permission/subagent 场景，因此相关收据仍诚实保留 `incomplete`。未知 native version 和无法绑定的 Bundle SHA 为 `null`，不猜测版本。

发行构建为十个插件分别产生 Bundle hash、插件/API 版本、实际依赖版本、许可标识和 Node target。Loader/发行 Bundle 的可搬移性测试与 native fixture 生命周期测试是两类证据，不能拼接成一次真实安装态 E2E。

## 行为变化与剩余验收边界

- 外部混合非文本输入现在明确失败；跨 Runtime 委派列表需明确 parent scope。这些行为消除静默丢失，不保持原先错误的成功响应。
- Broker Session fault 为永久终态；后续通过显式 fresh resume 恢复，不在同一 wrapper 内复活。无人值守意图恢复遵从持久化字段与原生实际支持。
- OMP 在 create 时启动当前 transport 探测能力；带逐 Session 环境的 DeepSeek open 拥有独立 managed Web。后者会增加同时存在的原生进程/连接，这是隔离工具环境所需的资源成本，本轮没有进行性能基准。
- 未运行真实 Codex Desktop 私有 Renderer/CDP 绑定、付费模型、真实用户历史变更、实际 `launchctl` 升级回滚、Linux/Windows 安装更新和部署态 SSH listener 验收。本地进程 fixture 与合成 UI 不能替代这些场景。
- 对 Grok 私有扩展、Antigravity DB/brain/schema、OMP 订阅与 DeepSeek 原生 profile，下一阶段应绑定实际版本、Bundle hash、环境和运行模式执行真实验收。当前修复没有伪造不支持的原生能力。

## 交付状态

本次交付包括全部本地修改、聚焦与集成回归、分区独立复审、逐项整改状态和可复核的文件指纹。未创建提交、PR 或远程发布。原评审报告与本报告分别记录“发现时状态”和“整改后状态”。
