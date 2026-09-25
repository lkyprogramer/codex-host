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

- macOS 上的逃逸进程：anchor 会追踪逃出进程组的后代（见 3.7）。但如果一个进程在两次扫描之间完成“创建、`setsid`、父进程退出”，仍会漏掉：被 launchd 收养后，内核会把它记录的父进程 id 改写为 launchd，它与原进程树之间不再有任何可用的关联。只有 Endpoint Security 能完全覆盖这一情形。
- anchor 自身被 SIGKILL：
  - Linux（PID namespace 模式）：内核会结束整棵进程树。
  - Linux（回退模式）：leader 随 pdeathsig 退出，其余进程由 3.7 的记录文件兜底回收。
  - macOS：同样由记录文件兜底，在下一次 Shim 启动或退出时回收。
  因此任何代码都不得直接杀死 anchor：`spawnOwnedProcess` 返回的 `child.kill()` 被改写为向 anchor 发 terminate（SIGKILL 表示立即终止，其他信号走宽限期）。Shim 的强制阶段也会跳过 anchor（3.7）。
- Linux 的 PID namespace 模式下，Harness 运行在单独的 user namespace 里，与宿主有以下可见差异：
  - `sudo` 等 setuid 程序会失效；
  - `ps` / `kill` 看不到宿主进程；
  - 无法 ptrace 附着到宿主进程；
  - 对端在 namespace 外时，`SO_PEERCRED` 取到的 pid 为 0；
  - 会话开始后宿主新挂载的文件系统（外置盘、sshfs）仍然可见，因为挂载传播设为 `MS_SLAVE`，已在容器中实测。

  设置 `CODEXHOST_PROCESS_ISOLATION=group` 可关闭该模式；无法创建 namespace 时，anchor 会发一条诊断说明回退原因。
- 逃逸追踪默认会随 Harness 一起结束那些 `setsid` 离组的常驻进程（tmux server、gpg-agent、ssh ControlMaster、构建守护进程）。设置 `CODEXHOST_PROCESS_ESCAPEES=keep` 可保留它们：这些进程既不计入进程组的释放条件，也不写入记录。但以下两种情况下仍会被结束：
  - 离组前它们已作为组员写入记录，而写入有节流，最长约 2 秒；若 anchor 恰好在这段时间内被杀，之后的回收仍会结束它们；
  - Linux 的 namespace 模式和 subreaper 模式下，它们仍随 Harness 一起结束。
- macOS 上每个 anchor 平时每秒扫描一次进程表，被追踪的进程 fork 时立即扫描（两次扫描至少间隔 20ms）。实测：Harness 每秒 fork 约 300 次时，anchor 约占 5% 单核（release 构建）。
- Windows 首版不启用 anchor，保持现状，Job Object 版本见第 5 节阶段 D。
- 每个存活 Harness 多一个很小的原生进程。

### 3.7 兜底机制：协调关闭、逃逸追踪、记录文件与 PID namespace

- **Shim 协调关闭**：Shim 的强制阶段会 KILL Host 进程树里除 anchor 之外的所有进程。anchor 已收到 TERM，正在回收自己的进程组，因此另给 5 秒期限，超时才 KILL。broker 的 LaunchAgent 通过 `CODEXHOST_PROCESS_ANCHOR_PATH` 使用 anchor，这些 anchor 的 lifeline 是 broker 进程本身（PL-11）。
- **所有权边界**：追踪和回收只认领同时满足以下条件的进程：
  - 创建时间晚于 Harness 首进程（macOS 比较单调递增的 `p_uniqueid`，Linux 比较启动时间）；
  - 属于当前用户；
  - pid > 1；
  - 不是 anchor 自身、它的祖先进程或回收器自身。

  沿父子关系遍历时，不满足条件的进程既不会被加入，也不会被当作跳板继续往下找。
- **逃逸追踪**：只沿“父进程仍存活”的父子关系发现新进程；发现过的进程按身份（pid + 实例 id）持续追踪，直到退出。macOS 上，被追踪进程每次 fork 都会触发一次立即扫描（kqueue `NOTE_FORK`，两次扫描至少间隔 20ms），平时每 1 秒扫描一次；Linux 每 2 秒扫描一次。终止时，逃逸进程与组内进程同样经历 TERM → KILL。
- **记录文件**（格式版本 2）：每个 anchor 把自己的实例 id，以及它拥有的全部进程的身份（pid + 实例 id，包括组内成员）写进每用户私有目录。进程变化时最多每秒写一次；只有确认进程组已清空后才删除；因超时放弃时，先写入最新状态再退出。私有目录为：macOS `confstr(_CS_DARWIN_USER_TEMP_DIR)`，Linux `/run/user/<uid>` 或 `/tmp`；目录名为 `codexhost-process-ledger-<uid>`，权限 0700，并校验属主。`codexhost-anchor --reclaim` 只处理 anchor 已不在的记录，处理方式如下：
  - 只认领记录中仍持有原 pid 的进程，以及它们此后经存活父进程链派生的后代。**不按进程组 id 认领**：anchor 不在后，组 id 可能已被复用成别人的进程组，哪怕那个新组的组长已经退出；
  - 逐个向满足边界的进程发 TERM，2 秒后发 KILL；
  - 进程全部结束后才删除该记录；
  - 属于其他开机周期的记录直接删除；版本不认识或无法解析的记录跳过、不删除，因为可能是更新版本的 anchor 正在使用的。

  Shim 在 Host 启动时于后台执行一次回收，Host 退出后再同步执行一次（最多 5 秒）。PID namespace 模式下不写记录（内核已保证清理）。
- **Linux PID namespace**：外层 anchor 用 `clone(CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNS)` 启动内层 anchor，内层作为新 namespace 的 init（1 号进程），挂载独立的 `/proc`，并设置父进程死亡信号 `PDEATHSIG=SIGKILL` 与外层绑定。外层 anchor 被 SIGKILL 时，内层随之死亡，内核结束 namespace 内的全部进程。外层只负责转发 TERM/INT/HUP 并镜像退出状态；Harness 死于信号时，由内层经管道把信号号告诉外层。不允许非特权 user namespace，或 `/proc` 被遮蔽的容器里，会自动回退到进程组模式。
- **dry run**：
  - 设 `CODEXHOST_PROCESS_ANCHOR_DRY_RUN=1` 时，anchor 只上报 `dryRun` 消息（会认领的逃逸进程、被边界拦下的进程），不向它们发信号，也不写记录；
  - `codexhost-anchor --reclaim --dry-run` 只打印会结束哪些进程，不发信号，也不删记录。
- **OOM**：原计划调高 Harness 的 `oom_score_adj`，现在取消。两者 `oom_score_adj` 相同，而内核按“内存占用 + 调整值”选择被杀进程，anchor 的内存占用远小于 Harness，本来就不会先于 Harness 被选中；调高只会让 Harness 更容易被系统杀掉。
- **事故记录（2026-09-25）**：初版追踪依赖一个错误假设——“进程被收养后 `puniqueid` 保持不变”。实际上 macOS 会把它改写为 launchd，导致在本机运行测试时，launchd 的全部子进程被认领并收到 TERM/KILL。用户自己的进程（包括终端）被结束；root 进程因权限不足未受影响。后续修正：
  - 删除按 `puniqueid` 认领的逻辑；
  - 引入上面的所有权边界；
  - 提供 dry run：在同一场景下，不加边界时原逻辑会认领 741 个进程，加边界后为 0；
  - 会发信号的测试先在 Linux 容器里验证，本机运行时对比前后进程列表。

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
| PL-11 | 低 | Aqua broker 崩溃时其 Claude 子进程组无人回收 | `harness-broker` | broker 内也使用 anchor（已完成，见 3.7） | D |

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
| abort 在 Harness 已结束后仍补发 `AbortError`，监听器不移除（复查发现） | 与 Node 一致：kill 生效才报告，释放 / 创建失败 / anchor 丢失时移除监听 |
| `kill()` 发起的回合失败无人得知（复查发现） | 只有 `close()` 的回合由该调用承接；`kill()` 与 anchor 自发回合的失败经 `onExitCleanupFailure` 上报 |
| 控制通道写超时可能截断一行并与下一条消息粘连（复查发现） | 非阻塞写加发送缓冲，可写时续写；退出前有界 flush 最后的 `released` / `spawnError` |
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

### 4.7 阶段 B 完成情况（分支 `feat/process-anchor`）

| ID | 状态 | 实现 |
| --- | --- | --- |
| HC-1 | 已修 | `process-guard.ts`：`unhandledRejection` 只报告，Host 继续运行；`uncaughtException` 让已注册的 Host（含 remote listener 与 Aqua broker）有序关闭，并以失败码退出，最长等待 30 秒；`run()` 结束后若仍有泄漏的句柄，5 秒后退出 |
| HC-2 | 已修 | `ManagedHarnessSession` 每个排队操作默认 120 秒期限，超时即判故障并释放队列；超时后才完成的 resume 会关闭它新开的原生 Session，而不是挂到已关闭的 Session 上；Host 退出时关闭 Session 与 Adapter 受 20 秒总预算约束，超出后由 anchor / Shim 回收剩余进程 |
| HC-3 | 已修 | `ExternalThreadRuntime.retire()`：故障的 Thread 在旧 Session 真正关闭前不会被恢复，同一原生会话不会同时存在两个进程 |
| HC-4 | 已修 | 合同新增 `releaseFailed`（向后兼容的新增状态）：`unknown` 只表示“这次没有尝试释放”；Claude Code、Grok、OpenCode、Cursor、Kiro 释放失败时统一返回 `releaseFailed`，Host 每次都报告并按退避重试 |
| HC-5 | 已修 | conformance 增加四个资源场景：中止的挂起不释放资源、活动 Turn 期间的挂起不释放资源、空闲挂起要么拒绝要么结束输出、关闭后的 Session 再次 close 正常且拒绝新 Turn、不挂起；计划中的“8 个资源场景”落地为这四项加上既有的 cleanup 与残留回读 |
| AD-16 | 已修 | conformance 检查 Turn 事件语法：每个 Turn 只开始一次，条目与交互只出现在开始与结束之间，只结束一次 |
| 关闭预算 | 说明 | 超出关闭预算后，Host 仍继续关闭 repository；尚未关完的 Session 如果之后才写入状态，这些最后的更新会丢失（只记诊断）。这是预算的代价：进程由 anchor / Shim 保证结束，状态以原生历史为准，下次恢复时会重新对齐 |
| RS-1 | 已修 | Shim 每轮只读取所有进程的 pid / ppid / pgid / 启动时间，可执行文件路径只对 root 与自己拥有的进程读取；实测单轮从约 1.8ms 降到约 0.6ms（debug 构建） |

### 4.8 兜底机制与阶段 B 的评审修复

| 评审项 | 修复 |
| --- | --- |
| H1 回收时可能误杀陌生进程组 | 记录格式升到 v2，保存全部已拥有进程的身份；回收只认领记录中的身份及其存活后代，不再按进程组 id 认领；补了组 id 被复用场景的单元测试 |
| M1 dry run 下进程组无法释放 | dry run 与 `keep` 模式都不把逃逸进程计入释放条件 |
| M2 namespace 挂载设为完全私有 | 改为 `MS_SLAVE`，已在容器中验证后挂载的文件系统可见；文档补充 namespace 模式的其他可见差异 |
| M3 旧 Host 不认识 `releaseFailed` | Host 把不认识的挂起状态按 `unknown` 处理，今后合同再新增状态也不会让 Session 故障；插件 API 版本号不变 |
| M4 常驻守护进程被一并结束 | 新增 `CODEXHOST_PROCESS_ESCAPEES=keep`，文档写明默认行为与这个开关的限制 |
| L1 回退时丢失原因 | namespace 回退时发一条诊断；TS 侧对相同的诊断只警告一次 |
| L2 回收器删除不认识版本的记录 | 不认识或无法解析的记录一律跳过，只删除属于其他开机周期的记录 |
| L3 更新后 `(deleted)` 后缀 | Shim 把 `<path> (deleted)` 也识别为 anchor |
| L4 dry run 报告不可见 | TS 侧把 `dryRun` 消息转为 warning |
| L5 扫描开销 | 已实测（见 3.6），扫描参数不变 |
| L6 强制退出截断输出 | 标准输出 / 标准错误仍有未写完的内容时，最多再多等 6 个宽限期 |
| L7 Shim 豁免分支 | 逐个进程发信号，遇到 pid 复用视为目标已消失；anchor 收尾期间每轮都对非 anchor 进程补发 KILL |
| L8 超预算后状态可能不落盘 | 文档说明（4.7） |
| L9 outcome fd 设置 CLOEXEC 失败 | 检查返回值，失败按参数错误退出 |
| 操作期限与释放时长冲突 | 挂起与 `withCurrentSession` 改用 25 分钟的释放期限；读取、命令、恢复仍为 120 秒 |
| 退役屏障 | 恢复被旧 Session 阻塞时，返回“previous native Session is still closing”；其余先移除后关闭的路径，要么对应记录已删除（无法恢复），要么先关后删，不需要屏障 |
| 进程身份读取失败时静默 | anchor 读不到自身身份时发诊断 |
| Turn 语法与 AD-1 冲突 | Turn 完成后才到的 `interaction.closed` 视为合法，开始前出现仍判违规 |
| Linux 同一 tick 边界 | 补单元测试 |
| 测试隔离 | Shim 测试的回收只作用于测试自己的临时记录目录 |

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
