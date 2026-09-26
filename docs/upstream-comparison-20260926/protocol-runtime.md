# 协议与 Host Runtime 上游对比（2026-09-26）

范围：fork `af255feb`（`feat/process-anchor`）与 upstream `997f62a0`（`main` / v0.10.1），共同基线 `7cc4db87`。本页只讨论 `host-runtime`、`protocol-core`、`mapping-store`、`harness-adapter`、`shared-contracts`、`harness-broker` 的公共协议、路由、历史、加载、连接、生命周期与性能。`U:` 指 `/Users/luo/Documents/github/codex-host-ori/codex-host/` 下 upstream HEAD 文件；`F:` 指本仓库 fork HEAD 文件。行号均为当前两棵树，不是提交时行号；提交号标识改造来源。建议是静态移植研究，未执行构建、测试、Desktop 或原生 Harness。

结论：优先补直接可复现的协议缺口；空闲释放只借可证明的约束，不覆盖 fork 的 delegation/observer、`ManagedHarnessSession`、process anchor 和资源生命周期协调。其他 Harness 原生 Session 导入、多账号及额度优化已按用户最新范围排除。

## 候选（按优先级）

### 1. P0 · 大型原生历史响应的 JSONL 与 WebSocket 两处边界（M）

- **来源/差距**：upstream `90abc1d3` 同时改了两处：`U:packages/protocol-core/src/jsonl.ts:8-45` 用 chunk 列表累积、按帧拼接并可显式限制字节；`U:packages/host-runtime/src/remote-official-connection.ts:40-49` 将私有官方 WebSocket 的 `maxPayload` 设为 `0`（`ws` 的无限值）。fork `F:packages/protocol-core/src/jsonl.ts:8-21` 每块重复拼接，且 `F:packages/host-runtime/src/remote-official-connection.ts:39-43` 保留 128 MiB 硬限。只改解析器不能修复超过 128 MiB 的 `thread/read` 响应。
- **价值/移植**：分两步处理。先移植线性帧读取及可选 `maxFrameBytes`；再只在经过本机/受控私有官方监听器校验的连接路径调整 `maxPayload`。不能把 `0` 当成通用 WebSocket 默认值或取消任意外部输入限额；核对现有 endpoint/认证边界、背压与进程内存预算。保留 fork 的 `writeBytes`、连接顺序和 observer。
- **依赖/实施**：无其他候选依赖。AI 对比 JSONL 和 remote connection 测试，补跨 chunk 大帧、连续多帧、显式越界及超过 128 MiB 的受控模拟响应。验收大历史完整返回、内存复制不随 chunk 数平方增长、非法/未终止帧仍拒绝、非私有连接不获得无限负载；回滚分别恢复解析器和该连接的上限。

### 2. P0 · 官方 Codex socket 为私有符号链接时的 SSH 启动（M）

- **来源/差距**：upstream `2e6e1bf1`；`U:packages/host-runtime/src/remote-official-app-server.ts:64-92,181-183` 检查链接所有者、目标 socket 与清理对象身份。`F:packages/host-runtime/src/remote-official-app-server.ts:82-99,163-165` 的 `lstat` 路径只接受 socket，链接会被判错；已启动但悬空的自有链接也可能留存。
- **价值/移植**：只将链接识别和自有路径清理放进 remote official socket 边界；必须同时验证 link 与 target 为当前用户的私有 socket，保留 fork `official-process-lifecycle`/process anchor 的 stop 顺序，不按路径名删除非自有 socket。
- **依赖/实施**：先核对当前官方 Desktop 版本是否以链接发布 socket。AI 添加 socket 与 symlink 两类临时文件测试、失败启动清理测试，再局部移植。验收 SSH 连接可用且非自有/非私有链接被拒；回滚局部 socket 检查。

### 3. P1 · 外部 Harness 的文件变更汇总（M）

- **来源/差距**：upstream `ee45196f`；`U:packages/protocol-core/src/file-change-summary.ts:91` 和 `codex-ui-projector.ts:289-306,1310-1330` 把同一 Turn 的文件变更合为稳定投影。fork `F:packages/protocol-core/src/codex-ui-projector.ts:279-286,1308-1335` 仍按单个 item 发 patch，多个工具或重复路径会形成分散项目。
- **价值/移植**：只修改外部 Turn 的投影与快照一致性，保留原始 Host item/`sourceItemIds` 作为事实；不得把汇总回写到 Native Session 或影响 delegation evidence 的原 item 身份。
- **依赖/实施**：先用现有 projector fixture 确认 fileChange 顺序、路径和 patch 规则；移植纯汇总函数及 projector 接线，补 live/replay 同结果、同文件多次变更与 cwd 路径测试。验收不丢原始变更且 UI 只出现一致的汇总；回滚 projector 接线即可。

### 4. P1 · 打开正在运行的 Subagent Thread 时保持 active（S）

- **来源/差距**：upstream `3cd01e58`；`U:packages/host-runtime/src/external-thread-runtime.ts:248-285` 在 register 时从 Host 状态种下 `running`。fork `F:packages/host-runtime/src/external-thread-runtime.ts:324-372` 固定 `running:false`，虽然 `F:packages/host-runtime/src/app-server-host.ts:2420-2422,4654` 跟踪 Subagent 状态，打开 Thread 时仍可能发出 idle。
- **价值/移植**：以 fork 现有 `#subagentThreadStatuses` 作为唯一真源注入读取回调；不从映射记录推断运行状态，也不改变普通 Thread。注意 observer 的独立终态保护。
- **依赖/实施**：AI 在 register 与打开 Thread 的测试中构造运行中的 child；以最小回调接线修复。验收打开期间状态 active、结束后 idle、普通 Thread 不变；回滚回调和初始运行状态接线。

### 5. P1 · fork 继承来源 Permission Mode（S）

- **来源/差距**：upstream `7a5ad219`；`U:packages/host-runtime/src/external-thread-fork.ts:157-198,209-230` 在新 Session 上尝试选择源 Thread 当前权限，并在成功后把 `requestedPermissionModeId` 交给 runtime；fork `F:packages/host-runtime/src/external-thread-fork.ts:39-70,155-196` 未执行该选择。上游会吞掉 `select` 失败并继续 fork，故其行为是尽力继承，不能声称严格继承。
- **价值/移植**：沿用 fork `SessionStateObserver` 的 effective mode；核对 at-create 固定权限能否在 `adapter.open` 时传入，不能只因不能 live select 就默默放弃。若来源权限比新 Session 默认权限更严格，失败后继续可能静默变宽，应明确拒绝该 fork 或让用户可见地确认，不能直接照搬上游吞错。成功选择后核对快照 effective mode、runtime 的 `requestedPermissionModeId` 和恢复持久化路径是否一致；保留 Harness 原生权限真源。
- **依赖/实施**：AI 核对 `harness-adapter` 能力合同及各 Adapter 的 at-create 行为，补成功、失败、固定权限、重启恢复和权限变宽场景；再局部接线。验收可继承时实际生效并在恢复后保持，不能证明安全等价时 fail closed；回滚该选择/拒绝分支。

### 6. P1 · macOS Mapping Store PID 复用后的锁恢复（M）

- **来源/差距**：upstream `0323f438`；`U:packages/mapping-store/src/mapping-store.ts:112-145,166-203` 在 macOS 锁争用时用 `/bin/ps` 读取进程启动时间。fork `F:packages/mapping-store/src/mapping-store.ts:117-150,159-197` 虽已记录锁 owner 的启动时间，但 `processIdentity` 在非 Windows 平台只返回 `startedAt:null`，因此 macOS 上 PID 复用仍可能误认为旧 owner 存活。
- **价值/移植**：候选为**核对与补回归**，而非直接替换 fork 锁实现；避免误删活 Host 锁导致双写。upstream `packages/mapping-store/test/macos-lock.test.ts` 是可借的实测场景。
- **依赖/实施**：AI 只移植 macOS 启动时间查询，并核对秒精度容差；借上游 `packages/mapping-store/test/macos-lock.test.ts` 补 PID 复用回归。验收旧/新锁格式、PID 复用和活 owner 互斥；回滚 macOS 查询及测试。

### 7. P1 · 实时 Harness 命令目录与检查时限（L）

- **来源/差距**：upstream `77b4b975`、`a014fbad`、`9a015338`；`U:packages/harness-adapter/src/text-session.ts:564-570` 声明 live catalog，`U:packages/host-runtime/src/app-server-host.ts:2579-2625` 检查/缓存，`U:packages/host-runtime/src/live-command-catalog-cache.ts` 维护按 Harness/cwd 缓存。fork `F:packages/harness-adapter/src/text-session.ts:617` 与 `F:packages/host-runtime/src/app-server-host.ts:2813-2854,3931-3970` 只有静态 adapter catalog 和已打开 Session 的 commands.list。
- **价值/移植**：让 draft 在启动 Turn 前看见当前 workspace 命令/skills；只通过 Adapter 合同获取原生命令，Host 不解析各 Harness 的私有格式。必须保留 fork 的 delegation `#` mention 路由、命令 admission 错误及权限边界。
- **依赖/实施**：需与 renderer/具体 adapter 的 owner 协同，本页只定义公共合同与 Host 接线。AI 先列能力和缓存失效规则，再按合同、时限、缓存、路由逐层实现；测试慢检查返回静态目录、cwd 隔离、失败不阻塞 Desktop、带参数命令不丢路由。验收 native 命令在 draft 可见而 fork delegation 仍准确；回滚新 live 能力并继续静态目录。

### 8. P2 · 原生任务分组排序请求透传（S）

- **来源/差距**：upstream `8d5e43bd`；`U:packages/protocol-core/src/thread-management.ts:269-297` 把 `section_position` 限定为 official-only，`U:packages/host-runtime/src/thread-list-aggregator.ts:91-97` 避免对该 sortKey 做外部聚合。fork `F:packages/protocol-core/src/thread-management.ts:263-305` 与 `F:packages/host-runtime/src/thread-list-aggregator.ts:89-95` 仍按外部时间排序路径处理。
- **价值/移植**：保留官方分组排序的原生语义和 cursor，不对外部 Thread 杜撰 section position；外部 Thread 仍支持时间排序。
- **依赖/实施**：AI 先核对 Desktop 发出的 `sortKey` 与 fork 的列表聚合 fixture，局部移植 decode/转发分支。验收 `section_position` 请求与 cursor 原样给官方后端，时间排序仍合并 external；回滚特殊分支。

## 已覆盖、仅借理念或拒绝直接移植

- **空闲释放**：upstream `c1f53734` 的 opt-in 全局设置（`U:packages/shared-contracts/src/idle-release.ts:3-18`、`external-thread-idle-release.ts:20-45`）与 fork 的 per-Session `resourceLifecycle.suspend`、串行唤醒、重试诊断（`F:packages/host-runtime/src/external-thread-runtime.ts:443-510`、`managed-harness-session.ts:357-396`）解决不同层级问题。不可用 upstream 关闭 Session 的方式覆盖 fork 持续会话与 process anchor；如需 UI 资源列表，只独立评估观测合同。
- **插件加载**：upstream `255cdb51`、`29c3079b`、`2c066ed1` 的有界并发、超时、关闭取消已在 fork `f75bd8ec` 等迁入；`F:packages/host-runtime/src/harness-plugin-loader.ts:134-204,294-357` 可见相同安全形状。拒绝再次整文件搬运，尤其不能丢失 fork 的 shutdown 顺序。
- **命令 steering**：upstream `30e27e68` 的核心 stop-then-start 时序在 fork `F:packages/host-runtime/src/external-turn-steering.ts:81-221` 基本同形；实时命令目录候选须另验参数/路由，不把此提交独立计为新能力。
- **用户明确排除：其他 Harness 原生 Session 导入**：上游 `b4aa4af4` 的 Claude 扫描/导入（`U:packages/adapters/claude-code/src/claude-session-import.ts:82-170`）不纳入本轮。fork 已有通用 importer、Pi/DSH 入口（`F:packages/host-runtime/src/harness-session-import.ts:53-69`），也无需扩展。现有已管理 Thread 的历史读取、恢复、fork/revise 属于本轮协议能力，不受此排除影响。
- **用户明确排除：多账号与额度优化**：上游 v0.8.2 `f3592bdb` 删除 Host-owned 多账号，fork `F:packages/host-runtime/src/codex-runtime/codex-runtime-pool.ts:18-33` 有自己的账号/Thread 绑定。此处不推荐改为 upstream 单 owner，不处理额度刷新、凭据导入或账号 UI。
- **`harness-broker`**：本段上游可见 `client.ts` 仅小幅变化；没有足够独立价值证明拆出移植任务，继续遵守 Claude Code 专属语义边界。

## 验证路径（建议，未执行）

fork `package.json:39-47` 给出 `typecheck`、`lint`、`test:typescript`；`tests/vitest.config.js:7-16` 收录各包 `test/**/*.test.ts`。实际实施时，每个候选先运行对应包的定向 Vitest 文件，再视公共合同影响运行 `npm run typecheck` 与 `npm run lint`；涉及官方 socket/进程的测试需独立验证 macOS/SSH 行为。此轮只读对比未运行这些命令。移植顺序建议 1→2→3→4→5；6 可独立修复，7 单独立项，8 可独立完成。
