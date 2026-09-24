# 进程 Anchor 方案与全项目整改计划

2026-09-24 基于全项目架构评审（Host 核心、进程生命周期、Adapter 协议对接、Rust 原生层四个维度）整理。本文记录采用的底层方案、全部已知问题、修复顺序与对应解决方案。条目状态随修复推进在本文更新。

## 1. 根因

资源释放问题反复出现，不是个别 Adapter 写错，而是两层职责放错了位置：

1. **进程所有权放在 Node 里、用 pid 维持。** 每个 Adapter 自己用一个 pid 证明“这个进程组是我的”并发信号回收。pid / pgid 复用、macOS 僵尸组 EPERM、失败后不能安全重试、Host 崩溃后的孤儿，都是这个模型的固有缺陷；TS 中已有 4 份不同的组回收实现（`harness-discovery/owned-process-tree.ts`、`grok/owned-group.ts`、`claude-code/process-fence.ts`、`deepseek-harness/executable.ts`），各自的所有权证明互不一致。
2. **会话生命周期由每个 Adapter 手写。** phase、close 缓存、准入 / 忙碌门禁、故障传播、挂起流程各写一遍，“挂起失败意味着什么”在不同 Adapter 里不同。

本计划先用 Rust 进程 anchor 从根上解决第 1 类问题（第 3 节），再按第 5 节顺序处理其余问题。

## 2. 边界

仓库规则是 Rust 负责原生启动与进程管理，不负责 Host 协议和 Harness 语义。Anchor 只做进程机制：创建、分组、终止、证明已退出。何时挂起 / 释放、原生优雅关闭顺序（stdin EOF、ACP `session/close`、SDK `query.close()`）、后台工作判定、恢复身份，仍留在 TS 与所属 Adapter。

## 3. 方案：Rust 进程 anchor

### 3.1 进程结构

每个 Harness 子进程外包一个 `codexhost-anchor` 进程：

```
Host (node) ──fd3 control/lifeline──▶ codexhost-anchor  (独立会话，自身一个组)
                                          └── harness leader P  (独立进程组 G = P)
                                                └── MCP / shell / 工具子孙（组 G）
```

- Host 以 `detached` 启动 anchor（独立会话），anchor 再以独立进程组 `G = P` 启动 Harness。stdio 0–2 直接继承给 Harness，Node 侧协议代码看到的仍是同一组管道。
- **anchor 不回收（reap）Harness leader，直到组 G 内不再有存活成员。** 未回收的 leader 使 pid P 与 pgid G 都不可能被复用，所以对 `-G` 发信号永远只命中本次创建的组。这消除 pid / pgid 复用这一整类问题，也让失败后的重试天然安全。
- Linux 上 anchor 设置 `PR_SET_CHILD_SUBREAPER`：组内进程 `setsid` / double-fork 出去后，一旦其父进程退出就被收养为 anchor 的子进程；这些子进程同样由 anchor 持有、未回收前 pid 不会复用，终止时按 pid 精确发信号。Harness leader 设置 `PR_SET_PDEATHSIG(SIGKILL)`，anchor 意外死亡时 leader 随之退出。
- macOS 没有 subreaper / pdeathsig：组 G 内的一切都覆盖；自行 `setsid` 逃出组的后代只能依赖 Shim 的全局账本兜底（操作系统限制，见 3.6）。

### 3.2 控制通道（fd 3）

Node 以 `stdio[3] = "pipe"` 创建一个双向 socket，anchor 在 fd 3 上收发 JSON 行：

| 方向 | 消息 | 含义 |
|---|---|---|
| anchor → Host | `{"type":"ready","pid":P,"pgid":G}` | Harness 已创建 |
| anchor → Host | `{"type":"spawnError","code":"ENOENT","message":…}` | Harness 无法创建；anchor 随后退出 |
| anchor → Host | `{"type":"exit","code":n}` / `{"type":"exit","signal":"SIGTERM"}` | Harness leader 已退出（未回收） |
| anchor → Host | `{"type":"unconfirmed","live":k}` | 一轮 TERM→KILL 后组内仍有存活成员；anchor 保持存活、继续钉住组，等待下一次 terminate |
| Host → anchor | `{"op":"terminate","graceMs":n}` | 对组执行有界 TERM → 等待 n ms → KILL → 等待确认 |

- **lifeline**：fd 3 读到 EOF 表示 Host 已退出（包括 SIGKILL 或崩溃，内核关闭 socket）。anchor 立即对组执行终止，在有限时间内反复尝试直到确认为空，然后退出。这保证 Host 与 Shim 同时死亡时也不留孤儿。
- anchor 收到 SIGTERM / SIGINT / SIGHUP 时按 terminate 处理（Shim 的兜底清理会发 SIGTERM）。
- Harness leader 自行退出后，anchor 自动回收组内剩余进程（与现有 tracker 的“leader 退出即回收”一致），确认为空后退出。
- **退出状态镜像**：确认组为空后，anchor 回收 leader，并以 leader 的退出码退出；若 leader 死于信号，则以同一信号结束自身。Node 侧 `child.on("exit", (code, signal))` 看到的仍是 Harness 的真实结果，只是在组已清空之后才到达。
- “组内存活成员”判定：leader 未退出即存活；其余成员按 pgid = G 且非僵尸枚举（Linux `/proc/*/stat`，macOS `proc_listpids(PGRP)` + `pbi_status != SZOMB`），Linux 另加被收养的子进程。只剩僵尸时视为已空，EPERM 不再是歧义。

### 3.3 TS API

`@codexhost/harness-discovery` 提供唯一的所有权入口：

```ts
spawnOwnedProcess(command, args, {
  cwd, env, stdio, windowsHide, windowsVerbatimArguments,
  closeTimeoutMs, onExitCleanupFailure,
}): { child: ChildProcess; tree: OwnedProcessTree | null; anchored: boolean }
```

- anchor 可用（POSIX 且 `CODEXHOST_PROCESS_ANCHOR_PATH` 指向可执行文件）时：`child` 是 anchor 进程（stdin/stdout/stderr 即 Harness 的管道），`tree.close()` 发送 terminate 并等待 anchor 以“已确认为空”退出；收到 `unconfirmed` 时 reject，**可以再次调用重试**。
- anchor 的 `spawnError` 转成 `child` 上的 `error` 事件（带 `code`），保留 Adapter 现有的 ENOENT 等启动错误处理。
- anchor 不可用（Windows、找不到二进制的开发 / 测试环境）时回退到现有 `detached` + `trackOwnedProcessTree`，语义与现在相同（失败不重试，fail-closed）。
- 一次性的短命令（模型目录、额度、版本探测）使用 `runOwnedProcess`：超时、超出输出上限或被中止时，整棵进程树停止后才 reject。
- Adapter 不再直接对任何 pid 发信号：`packages/*/src` 中除 `harness-discovery` 的回退 tracker 外禁止 `process.kill(-pid)`，由 `tools/check-boundaries.mjs` 按语法树检查。Windows 的 `taskkill` 目前只存在于该回退 tracker，阶段 D 由 Windows anchor 取代。

### 3.4 打包与定位

- 新 crate `crates/anchor`，二进制 `codexhost-anchor`，纳入 workspace 默认成员与 `build:rust`。
- 安装布局与 `codexhost-shim` 同目录（`libexec/`）；开发环境同在 `target/debug/`。
- Shim 启动 Host 时注入 `CODEXHOST_PROCESS_ANCHOR_PATH`（Shim 所在目录下的 `codexhost-anchor`，存在才注入）。
- 远程 SSH Host 的 wrapper 是 Shim 的拷贝，anchor 不在它旁边；受管 profile 在原 Shim 旁的 anchor 可执行时导出该变量。
- `npm run test:typescript` 先编译 anchor，`tests/vitest.setup.js` 为整个测试套件注入它，所有 Adapter 的真实进程测试都走生产路径。
- 发行 payload 与 npm 包加入该二进制，并参与现有签名 / 公证流程。

### 3.5 能消除的问题

| 问题类 | 现状 | 有 anchor 后 |
|---|---|---|
| pid / pgid 复用误杀 | 各处分别证明所有权，仍有残余窗口 | 消除：leader 未回收，组号被钉住 |
| 清理失败不能重试 | tracker 刻意不重放，只有 Grok 自带重试 | 消除：重试天然安全 |
| 僵尸组 EPERM 误判 | 3 份实现各自处理 | 消除：按非僵尸成员判定 |
| Host / Shim 同时死亡留下孤儿 | POSIX 无兜底 | 消除：lifeline |
| leader 崩溃后子孙残留（Claude） | Claude 不在 leader 退出时回收 | 消除：anchor 自动回收 |
| Linux 上 setsid / double-fork 逃逸 | 只靠 Shim 500ms 快照 | 消除：subreaper |
| 事件循环上同步 `ps` / `kill` | Grok 启动路径同步 `ps` | 消除 |
| 4 份 TS 组回收实现 | 语义各异 | 收敛为 anchor + 一份回退实现 |

### 3.6 已知限制

- macOS 上自行 `setsid` 并在父进程存活时逃出组的后代，anchor 无法跟踪；仍由 Shim 账本兜底。
- anchor 自身被 SIGKILL：Linux 上只有 leader 随 pdeathsig 退出，组内其余成员会存活；macOS 上整组失去看护。两者都只能靠 Shim 账本兜底。因此任何代码都不得直接杀死 anchor：`spawnOwnedProcess` 返回的 `child.kill()` 被改写为向 anchor 发 terminate（SIGKILL 即立即终止，其他信号走宽限期），SDK 的关闭强杀、Node 的 `signal` 选项和 Adapter 自己的 kill 都经过这条路径。
- Windows 首版不启用 anchor，保持现状，Job Object 版本见第 5 节阶段 D。
- 每个存活 Harness 多一个很小的原生进程。

## 4. 问题清单

标记：**已核实** = 对照代码复核；**推断** = 读代码推断，未复现。状态：待修 / 已修（附提交）。

### 4.1 进程生命周期（PL）

| ID | 严重度 | 问题 | 位置 | 解决方案 | 阶段 |
|---|---|---|---|---|---|
| PL-1 | 中 | Shim 与 Host 同时死亡时 Harness 子进程成为孤儿，下次启动也不回收 | `crates/shim/src/local_runtime_lease.rs:715` | anchor lifeline | A |
| PL-2 | 中 | Grok 启动热路径同步调用 `ps`（最长阻塞 1s）；`ps` 不可用时永久无法回收 | `grok/src/owned-group.ts`、`acp-transport.ts` | 迁移到 anchor，删除 owned-group | A |
| PL-3 | 中 | DeepSeek 版本探测直接 SIGKILL 整组、不确认为空、leader 回收后仍可能发信号 | `deepseek-harness/src/executable.ts:101-131` | 迁移到 `spawnOwnedProcess` | A |
| PL-4 | 中 | Claude CLI leader 崩溃时不回收组内 MCP / 后台 shell，直到 close | `claude-code/src/sdk-transport.ts` `#spawn` | anchor 自动回收 | A |
| PL-5 | 中低 | 两种所有权证明在“组清空 → pid 复用为他人组长 → 该组长退出”时同时失效 | `owned-group.ts`、`process-fence.ts` | anchor 钉住组号 | A |
| PL-6 | 中低 | 公共 tracker 失败后永不重试，7 个 Adapter 泄漏后只能 fail-closed | `harness-discovery/src/owned-process-tree.ts:104-116` | anchor 可重试 | A |
| PL-7 | 低 | 只杀 leader：Kiro `list-models`、Antigravity `runCli`、Windows 下 Antigravity Turn | `kiro-cli/src/acp-transport.ts:327`、`antigravity-adapter.ts:485,753` | POSIX 迁移到 `spawnOwnedProcess`；Windows 见阶段 D | A / D |
| PL-8 | 低 | 4 份 TS 组回收实现、Claude 两份相同的 `#spawn` | 见第 1 节 | 收敛到 harness-discovery | A |
| PL-9 | 低 | owner pid 存活检查无身份校验（仅影响可用性）；mapping-store 在 Windows 上同步 powershell 无超时 | `harness-broker/src/server.ts:117-140`、`mapping-store.ts:117-134` | 记录启动时间做身份；异步 + 超时 | D |
| PL-10 | 低（Windows） | Grok taskkill 用裸名、无超时、忽略返回码；tracker 用 `spawnSync` 阻塞事件循环；leader 自然退出即报清理失败 | `owned-group.ts:58-64`、`owned-process-tree.ts:54-61` | Windows anchor（Job Object） | D |
| PL-11 | 低 | Aqua broker 崩溃时其 Claude 子进程组无人回收 | `harness-broker` | broker 内也使用 anchor | D |

### 4.2 Host 核心（HC）

| ID | 严重度 | 问题 | 位置 | 解决方案 | 阶段 |
|---|---|---|---|---|---|
| HC-1 | 高 | 插件在 Host 进程内加载，无 `unhandledRejection` / `uncaughtException` 处理；一个插件即可让 Host 退出，连带官方 Codex 代理 | `harness-plugin-loader.ts:134`，全仓非测试代码无处理器（已核实） | 进程级处理器：诊断后有序关闭；长期插件进程外化 | B |
| HC-2 | 高 | Host→Adapter 的 suspend / resume / open / close 无期限且共用一个队列；Host 关闭无总预算 | `managed-harness-session.ts:239,329`、`app-server-host.ts:765-772,885`（已核实） | 每个调用加期限，超时标记 abandoned 并后台重试 close；关闭总预算，超出后由 anchor / Shim 强制回收 | B |
| HC-3 | 高 | Thread 故障后先从运行时移除再关闭旧 Session，下一请求可为同一原生会话启动第二个进程 | `app-server-host.ts:4191-4193`（已核实） | 按原生会话建立“退役中”屏障，旧实例 close 完成前禁止 restore | B |
| HC-4 | 中 | 挂起失败语义不统一（Cursor / Kiro 故障，Claude / Grok 返回 unknown）；unknown 同时表示“暂不可挂起”与“释放失败” | `cursor-cli/src/adapter.ts:697-719`、`kiro-adapter.ts:1546-1573` | 合同拆出 `releaseFailed`；长期由 SessionKernel 统一 | B / E |
| HC-5 | 中 | conformance 完全不覆盖资源生命周期 | `harness-adapter/src/conformance.ts` | 补 8 个资源场景 | B |
| HC-6 | 中 | mapping-store 整字段覆盖无版本前提，delegation 并发写可能丢失（推断） | `external-thread-repository.ts:473-540`、`mapping-store.ts:705-750` | 在 store `#update` 内合并或加 revision CAS | C |
| HC-7 | 中 | `thread send` 去重只在内存，Thread 卸载后重试生成重复 Turn；`thread release` 先唤醒未加载的 Thread 再挂起 | `harness-delegation-coordinator.ts:532-541,1118` | 去重持久化；冷 Thread 直接返回已释放 | C |
| HC-8 | 低 | Harness 专有分支泄漏进 Host；`stopOwnedJobs` 靠鸭子类型探测 | `external-thread-runtime.ts:770,789,849`、`coordinator:1498-1512` | 改为能力声明并校验 | E |
| HC-9 | 低 | 配置以字符串 `transportModelId` 持久化，7 个 Harness 仍写旧格式；三个 select 方法近乎相同 | `protocol-core/model-routing.ts:511-547`、`app-server-host.ts:2937,3022,3107` | 结构化字段 + 通用 `selectConfiguration` | E |
| HC-10 | 低 | `ManagedHarnessSession` 被强转为 `HarnessSession`；`#fail` 一律报 processExited；恢复校验用 `JSON.stringify` 比较能力 | `external-thread-runtime.ts:368`、`managed-harness-session.ts:442,531` | `implements` 合同；区分故障原因；结构化比较 | C |
| HC-11 | 低 | turn.cancel 与慢操作共用队列，取消被阻塞 | `managed-harness-session.ts:233,286` | 取消走独立通道 | C |

### 4.3 Adapter 协议对接（AD）

| ID | 严重度 | 问题 | 位置 | 解决方案 | 阶段 |
|---|---|---|---|---|---|
| AD-1 | 中高 | Grok 取消后待处理 approval 未删除，之后回复仍返回 accepted 并记为 responded | `grok-adapter.ts:973-1029`（已核实） | 取消时删除并发 `interaction.closed{cancelled}` | C |
| AD-2 | 中 | Kiro 真实 transport 吞掉 cancel 错误，失败分支永远走不到 | `kiro-cli/src/acp-transport.ts:658-665`（已核实） | 传出错误，用真实 transport 夹具测试 | C |
| AD-3 | 中 | Grok setModel / setSessionMode / interject / compact 无期限，原生不响应时 Session 永久 busy | `grok/src/acp-transport.ts:951,1002` | 配置写入超时即退役连接 | C |
| AD-4 | 中 | Antigravity 取消清理失败只标记关闭，不发故障、不结束输出 | `antigravity-adapter.ts:1373` | 发 `session.faulted` 并结束通道 | C |
| AD-5 | 中（推断） | Antigravity 原生 Turn key 取自 `num_turns`，同 key 覆盖历史；语义未经真实 CLI 验证 | `antigravity-adapter.ts:985`、`history.ts:355` | 真机核对后改用持久身份 | C |
| AD-6 | 低 | Kiro 不按 sessionId 过滤 update | `kiro-cli/src/acp-transport.ts:803` | 过滤 | C |
| AD-7 | 低 | 超时语义各 Adapter 不一致；Pi / OMP `set_model` 超时后连接继续使用 | `pi-rpc-session.ts` `#armCommandTimeout` | 统一“只读 reject / 配置写入 retire” | C |
| AD-8 | 低 | Cursor 两轮之间的 update 缓存上限 10 万条，超限抛异常 | `cursor-cli/src/transport.ts:141` | 空闲 update 不进 replay | C |
| AD-9 | 低 | 用输出文本正则判定状态（Grok subagent、Antigravity 权限拒绝） | `grok-subagent.ts:308-320` | 改用结构化字段 | E |
| AD-10 | 低 | Claude 自主 Turn key 无 uuid 时跨重启不稳定 | `sdk-transport.ts`、`claude-code-adapter.ts` | 使用原生持久身份 | E |
| AD-11 | 低 | Pi 启动超时计时器未清理；Pi / OMP 缓冲无上限 | `pi-rpc-session.ts:587` | 清理计时器、设上限 | C |
| AD-12 | 低 | Kiro 终态仅在观察到元数据时带 nativeTurnRef、从不带 checkpoint、processExited 原因丢失 | `kiro-adapter.ts` | 补齐 | C |
| AD-13 | 结构 | Pi / OMP 约 6k 行重复 | `pi-*`、`omp-*` | Pi-family 共享核心 | E |
| AD-14 | 结构 | 4 个 ACP Adapter 连接层重复且超时语义不一 | 见 `acp-layer-follow-up.md` | 统一语义后抽 `acp-core` | E |
| AD-15 | 结构 | 超大模块：`app-server-host.ts` 4970 行、`deepseek modern/session.ts` 2951 行、`claude-code-adapter.ts` 3038 行 | — | 按职责拆分 | E |
| AD-16 | 结构 | conformance 不检查每个 Turn 的事件顺序 | `harness-adapter/src/conformance.ts` | 增加 Turn 语法检查与 cancel / 配置超时场景 | B |

### 4.4 Rust 原生层（RS）

| ID | 严重度 | 问题 | 位置 | 解决方案 | 阶段 |
|---|---|---|---|---|---|
| RS-1 | 高 | macOS Shim 每 20ms 全系统快照并对每个 pid 调 `proc_pidpath`，实测约 10.7% 单核 | `crates/platform/src/process.rs:170`、`shim/src/lib.rs:142`（代码已核实） | 先按 pgid / ppid 过滤再取路径，或 kqueue + 低频兜底 | B |
| RS-2 | 中 | macOS 更新器两次 rename 之间崩溃会丢失 app；备份在确认新版能启动前删除 | `crates/updater/src/install.rs:202-221` | 启动时恢复遗留备份；新版健康后再删备份 | D |
| RS-3 | 中 | Windows 上 Desktop 关闭 stdin 后直接 TerminateJobObject，无宽限 | `crates/shim/src/lib.rs:260-263` | 先通知 Host 有序关闭，再硬杀 | D |
| RS-4 | 低 | Windows 进程 spawn 后才加入 Job，存在逃逸窗口 | `process_supervision.rs:195` | `CREATE_SUSPENDED` 或 `PROC_THREAD_ATTRIBUTE_JOB_LIST` | D |
| RS-5 | 低 | Shim 在 macOS 上 killpg / 按 pid 杀逃逸后代存在 TOCTOU | `shim/src/lib.rs:176`、`process.rs:524-550` | anchor 覆盖 Harness 后降低账本依赖 | D |
| RS-6 | 低 | 更新器仅按 pid 等待 launcher，pid 复用时超时 180s（fail-safe） | `crates/updater/src/main.rs:61` | 加入启动时间身份 | D |

### 4.5 此前已记录的残余风险

- Claude 释放未确认期间旧进程写入的原生历史不会投影到 Host（见 `harness-resource-lifecycle.md`）。anchor 落地后，释放失败只剩“组内进程拒绝退出”这一种情况，概率进一步降低。
- Antigravity 历史孤儿子任务判定依赖“每个 Turn 进程等待自己的子任务”这一前提。

### 4.6 阶段 A 完成情况（分支 `feat/process-anchor`）

阶段 A 首轮实现后经两路独立评审（Rust anchor、TS 集成），以下问题已在同一分支修复并补回归测试：

| 问题 | 修复 |
| --- | --- |
| Claude SDK 关闭时对 anchor 发 SIGKILL，早于 anchor 自己的 KILL，TERM 免疫的组员逃逸（已复现 4/4） | `child.kill()` 改写为受管 terminate；abort 信号同样走 terminate |
| 缺失可执行文件时 `spawn` / `exit 127` 多发，OMP 启动挂满超时、Grok / Kiro 报错类别变化，无监听器时可能崩溃 Host | anchor 报告 `ready` 前扣住 `spawn` / `exit` / `close`；`spawnError` 只发 `error` 与 `close`；无监听器改为 warning；OMP `#ready` 在故障时立即失败 |
| Linux：leader 存活期间被收养的后代退出后成为僵尸不被回收 | SIGCHLD 唤醒时回收 |
| Linux：KILL 之后才被收养的逃逸后代存活到下一轮 | Forced 阶段每个 tick 对组与收养子进程补发 KILL |
| 进行中的长宽限期不能被更紧急的 terminate / lifeline 丢失提前 | 更早的截止或 grace 0 立即前移 |
| macOS：其他 uid 的组员（sudo / su）被误判为已退出 | 改用不受 uid 限制的 `PROC_PIDT_SHORTBSDINFO`，读取失败按存活 |
| Linux 终止期间每 20ms 扫描整个 `/proc` | 扫描间隔 20ms 起指数退避至 250ms |
| 回退 tracker 失败后永不重试（Windows 上 Grok 退化） | leader 未被回收前允许重试，回收后保持失败 |
| Windows 回退：每次短命令正常退出都报清理失败；taskkill 同步阻塞事件循环 | Windows 不在 leader 退出时自动清理；taskkill 改为异步 |
| DeepSeek 探测清理预算与 anchor 窗口错位 | TERM / KILL 各占预算一半 |
| 其余：多线程主线程退出误判、重复计数、不可读 `/proc` 无诊断、控制写阻塞、Shim 符号链接路径与继承环境、Host 请求的回合被误报为退出清理失败、anchor 路径永久缓存、非法 `closeTimeoutMs` | 均已修复；anchor 诊断经 `diagnostic` 消息转为 Host warning |


| ID | 状态 | 说明 |
| --- | --- | --- |
| PL-1 | 已修（POSIX） | lifeline：Host 被 SIGKILL 后整棵 Harness 树退出，由 `harness-discovery` 与 anchor 集成测试覆盖 |
| PL-2 | 已修 | Grok 改用 `spawnOwnedProcess`；`owned-group.ts` 与同步 `ps` 已删除 |
| PL-3 | 已修 | DeepSeek 版本探测与 modern Web 均经 owned tree；`killDeepSeekProcessTree` 已删除 |
| PL-4 | 已修 | Claude CLI 退出即回收组内剩余进程；`process-fence.ts` 已删除 |
| PL-5 | 已修（POSIX） | leader 未回收即钉住组号 |
| PL-6 | 已修（POSIX） | anchor 下 `close()` 失败后可重试；回退 tracker 仍按设计 fail-closed |
| PL-7 | POSIX 已修 | Kiro `list-models`、Antigravity `runBuffered` 改用 `runOwnedProcess`；Windows 部分留在阶段 D |
| PL-8 | 已修 | TS 中只剩 `harness-discovery` 的回退 tracker 对进程组发信号，边界检查强制 |

阶段 A 顺带去掉了测试中的一类隐患：Pi、OMP、OpenCode 的 fake 进程带固定 pid（42000、45001、91337），以前被真实 tracker 接管，close 时会对同号的真实进程组发信号；现在 fake 只返回不接触系统进程的 fake tree。

## 5. 修复顺序

| 阶段 | 内容 | 覆盖条目 |
|---|---|---|
| **A（当前分支）** | Rust anchor crate 与集成测试；`spawnOwnedProcess`；Shim 注入路径；打包；全部 POSIX Adapter 迁移；删除手写回收实现；边界检查禁止直接发信号 | PL-1 … PL-8 |
| **B** | Host 稳健性与门禁：进程级异常处理、调用期限与关闭预算、退役屏障、挂起失败语义、conformance 资源与 Turn 语法；Shim CPU | HC-1 … HC-5、AD-16、RS-1 |
| **C** | Adapter 与 Host 局部缺陷 | AD-1 … AD-8、AD-11、AD-12、HC-6、HC-7、HC-10、HC-11 |
| **D** | Windows anchor（Job Object）、broker anchor、更新器与 Shim 原生问题 | PL-7（Windows）、PL-9 … PL-11、RS-2 … RS-6 |
| **E** | 结构升级：SessionKernel 与 `workLevel` / `release` 合同（需升级插件合同版本）、`acp-core`、Pi-family 核心、大模块拆分、能力声明 | HC-4（长期）、HC-8、HC-9、AD-9、AD-10、AD-13 … AD-15 |

## 6. 阶段 A 验收

- Rust 集成测试（macOS 本机；Linux 在容器中）：忽略 TERM 的后代被 KILL；leader 退出后剩余后代被回收；Host 侧关闭 fd 3（lifeline）后整组退出；退出码与信号镜像；`unconfirmed` 后可再次 terminate；只剩僵尸的组判定为空；Linux 上 setsid 逃逸的后代被收养并回收；Harness 不存在时报告 `spawnError`。
- TS：`spawnOwnedProcess` 在真实 anchor 下的关闭、重试、leader 退出回收、`error` 事件，以及无 anchor 时的回退路径；全部 Adapter 测试在 anchor 路径下通过。
- 静态检查：`tsc`、`eslint`、`check-boundaries`（新增禁止直接发信号规则）、`cargo fmt` / `clippy` / `test`。
