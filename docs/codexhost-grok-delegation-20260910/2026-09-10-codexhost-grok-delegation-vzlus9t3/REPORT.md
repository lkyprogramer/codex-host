# codexhost-delegation / Grok 替代迁移派发：调研报告与改造方案

日期：2026-09-10。状态：调研及合成实验完成，方案待实施。

**结论：建议采用“Grok 主执行、Codex 按需协调/升级”的目标，而不只把 Grok 当作辅助搜索工具。** 当前 Grok 委派已能完成真实文件开发、定向测试、本地提交、同会话续接和独立缺陷审查。要稳定替代现有任务创建与子代理派发，还需优先修复并发创建恢复、取消后的活动命令、任务身份和列表状态，再接通机器可核验的审查证据。单纯把 create_thread/spawn_agent 替换成 delegate start 不足以完成目标。

本轮遵循最新要求：只调研、测试、给方案。没有由本任务修改 codex-host 或 lishu-v2 的源码、规则、profile、业务数据；没有部署或重启 Host。文件修改、测试和 Git 提交仅发生在本轮创建的合成临时仓库。原始命令、返回、测试日志、源码绑定与合成 Git bundle 随报告保留。

**1. 环境、证据与结论边界**

- 运行测试连接既有 Host：监听进程 PID 8775，启动时间 2026-09-10 09:55:29（本机时区），没有为实验替换运行进程。[进程记录](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/runtime-process.json)
- 调研开始时磁盘 npm 平台包为 0.6.2-local.1，收尾观察到 0.6.2-local.2；期间源码分支也发生外部变化。最终源码快照为 codex-host local/all-fixes @ 80f3116530c47e05ec24b97f267c011bbf7be982，lishu-v2 develop-w7 @ ff87a3564b0f7455266cd1291c7455543f61ca82，后者含原有未提交改动。
- 源码、磁盘安装包、运行中的进程分别记录；没有取得运行进程所加载 bundle 的原始 SHA，不把收尾磁盘版本当成测试进程版本。相关文件 SHA256 和 Git 状态见 [source-binding.json](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/source-binding.json)。
- 当前注入的 CODEXHOST_CLI_PATH 仍指向 npm 平台包的原生 launcher，执行 help 就报找不到 runtime/node。本轮核验同一安装的正式 JavaScript CLI 后，仅在测试子进程环境中校正路径；所有操作仍经过该 CLI 和原 Host Runtime，没有直接调用私有控制接口或搜索别的 Host。[原入口失败](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/inherited-cli-help.json)
- 本轮派发对象全部为 Grok，没有调用 Codex 原生子代理或以 codex 为 Harness 创建执行者。Grok 调用经自己的 Adapter/ACP，源码只在 harnessId=codex 时走官方执行分支。[路由](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/harness-delegation-coordinator.ts:185)
- 这能证明执行职责确实交给 Grok；未测量 Codex/Grok 账户额度变化，不给出“节省百分之多少”或总体价格结论。合成实验也不证明完整 Java/Spring 迁移质量、真实 V2 HTTP 验收或长时运行可靠性。

**2. 已执行的测试**

| 检查 | 实际结果 | 依据 |
|---|---|---|
| Harness 发现 | grok ready；默认 grok-4.6 / medium；4.6 支持 xhigh/high/medium/low | [目录返回](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/harness-catalog.json) |
| 创建、等待、读取、续接 | 初次 token 回显与同会话 token 回忆通过；取消后仍可续接 | [续接结果](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/read-after-followup.json) |
| 已完成请求串行重试 | 同 request-id 返回原 delegation/thread，未新建 | [重试结果](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/sequential-existing-retry.json) |
| 不同任务并行 | 两项源码调查与一个 writer 的运行区间重叠；证明至少 3 个 Grok 任务可并行，不代表最大容量 | [任务时间与状态](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/concurrent-status.json) |
| 独立 worktree writer | 实际 cwd/branch/base 对齐，只修改 scheduler.py，形成本地 commit | [文件和提交读回](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/writer-readback.json) |
| 开发结果验证 | writer 候选 9 个测试通过；基线未实现时失败 | [writer 测试](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/writer-tests.json)、[基线失败](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/writer-before-tests.log) |
| 指定模型与思考档位 | reviewer 请求与生效值均为 grok-4.6 / xhigh | [创建回执](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/reviewer-start.json) |
| 独立只读审查 | 在另一任务、另一 worktree 中找出预埋错误的两个影响；HEAD/status 未变 | [审查结果](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/reviewer-result.json)、[读回](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/reviewer-readback.json) |
| 已知负例复核 | 合成坏候选 9 个测试中 2 个按预期失败，支持 reviewer 的两项结论 | [负例测试](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/reviewer-tests.json) |
| 有界等待 | 1ms 等待返回 running + timedOut=true，原任务继续并最终完成 | [超时返回](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/writer-timeout.json) |
| 运行中 send | 返回 THREAD_BUSY，新消息未被接受 | [忙碌拒绝](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/writer-busy.json) |
| 取消活动命令 | 回合 interrupted，但 Python PID 仍活着，随后写出 late.txt | [取消终态](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/cancel-terminal.json)、[即时进程](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/cancel-process-after-ack.json)、[迟到写入](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/cancel-process-later.json) |
| 同 request-id 并发创建 | 两个请求都失败，留下无法读取/取消的 creating 记录 | [并发原始结果](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/concurrent-idempotency.json)、[重试](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/concurrent-recovery.json) |
| 列表续接状态 | follow-up 已 running，但 parent 列表仍显示上一轮 completed/interrupted | [列表](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/list-after-followup.json)、[同一调查任务实际 running](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/host-recovery-assessment.json) |
| 增量读取成本 | cursor 已到末尾，messages=[]，仍重复完整 result/progress；该小样本返回 1929 bytes | [两次读取](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/incremental-read.json) |
| PROFILE 审查执行约束 | 合成 Sol/high actor 被接收；改为 Grok/xhigh 则 CODE/legacy 同时被拒绝 | [直接调用校验结果](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/profile-actor-probe.json) |

Writer 的合成 BASE 为 90ff79528e30bf39e1e245c4b5e72a107861908a，正确交付为 e108154c550e38ab9662d67cf60af4c71eeb46b5。之后由主协调者在独立 reviewer worktree 中故意加入 completed.add(task_id)，生成坏候选 ad142f653f7be5f14e5244c72f910fe1f585aea3，用于盲测 reviewer。坏候选不是 Grok writer 的交付，也没有进入业务仓库。它同时违反“不修改调用方输入”和“本批选中不等于依赖已完成”两条合同。

**3. 必须优先处理的缺口**

**A. 并发创建缺乏完整原子性和失败恢复（已实测）**

同一个 parent、cwd、harness、task、request-id，并发执行两次 delegate start，分别返回：

- DELEGATION_FAILED: External Thread was not found
- DELEGATION_FAILED: Delegation Request ID is duplicated

随后 parent 列表出现 67308aba-8ce7-48ca-9ca8-eb6da79638f6，状态 creating。串行重试返回该任务且 turnId=pending。read/cancel 却报告没有 Codex Account binding。[读取失败](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/concurrent-orphan-read.json)、[取消失败](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence/concurrent-orphan-cancel.json)

源码先查 request、再建 provisional Thread 与 Delegation，多个异步步骤之间没有将同一创建作为一个完整操作合并；存储层也存在检查、await 写文件、更新索引的分离。[Coordinator](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/harness-delegation-coordinator.ts:198)、[MappingStore](/Users/luo/Documents/github/codex-host/packages/mapping-store/src/mapping-store.ts:364)

改造应包含：同一创建请求 single-flight；绑定 parent/harness/cwd/task/configuration 后拒绝冲突重用；失败清理只处理本次真实拥有的 provisional 对象；已持久化 creating 的恢复检查；缺失 external Thread 时保留 external 身份并返回可诊断状态，不能误走官方账户路径。不能仅增加一句“重试用相同 request-id”。

**B. 回合取消不等于任务进程停止（已实测）**

本次 cancel ACK 与 interrupted 都早于 Python 退出，迟到写入确实出现。原测试进程后来正常退出，无需强杀，但该行为足以否定“interrupted 后立即复用 worktree/资源”的调度假设。

Grok Adapter 的 cancel 调用 ACP session/cancel；进程树退出处理位于 transport close，未在 turn cancel 中执行。[Adapter](/Users/luo/Documents/github/codex-host/packages/adapters/grok/src/grok-adapter.ts:778)、[Transport](/Users/luo/Documents/github/codex-host/packages/adapters/grok/src/acp-transport.ts:875)

建议把“回合终态”和“活动作业已静止”分别表达。普通取消保留原生语义；接管所需的 drain/停止操作必须基于该 Session 的已知 job/进程所有权，并经过真实 shell 残留验证。可以调查复用 transport close/resume，但当前 close 只在等待进程退出超时后处理进程树，不能未经验证就认为所有后代均被终止。禁止用按目录 pkill 的方式补洞，也不能声称杀进程撤销已提交的 DB/HTTP 写。暂时无法证明作业停止时保留相应资源占用，做原 owner readback/cleanup。

**C. 取消前后 Turn 身份不稳定（观察已证实，唯一根因尚未锁定）**

同一次追踪中，send/cancel 的 Turn ID 是 a56c29e5-e3f6-45ba-9eef-333b1262be13，终态 read/wait 的 ID 却为 43d839cc-ec9c-4e24-bb07-f759eaf34c05。

源码存在一个可解释路径：取消结算拿不到唯一 nativeTurnRef 时仍允许结束；随后历史刷新对没有映射的 native turn 分配新 Host UUID。[结算](/Users/luo/Documents/github/codex-host/packages/adapters/grok/src/grok-adapter.ts:1140)、[终态身份](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/external-thread-runtime.ts:389)、[历史映射](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/external-thread-repository.ts:408)

本轮没有读取私有原生 transcript，不能把这一代码路径当成已经确认的唯一根因。改造验收需锁定一轮的 stable ID，显式支持 expectedTurnId，并验证取消、失败、历史刷新、恢复后仍可定位同一实际 attempt；不能把“最新一轮”当作原请求完成证明。

**D. 列表状态滞后，会误导调度（已实测）**

send 开新轮后，parent list 仍展示上一轮的 completed/interrupted。Host 源码在 terminal/read 时更新 Delegation 状态；parent list 直接读取持久记录。[send](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/harness-delegation-coordinator.ts:350)、[list](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/harness-delegation-coordinator.ts:464)、[terminal](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/app-server-host.ts:4065)

应在统一的 Turn 开始/结束路径更新同一状态真源，列表与 read 按当前运行状态一致返回。增加 revision/cursor 后，也应避免旧事件覆盖新 attempt。

**E. npm CLI 路径修复尚未在本会话运行环境生效（已实测）**

最终源码已经包含优先使用 npm launcher 的改动，不需要本方案重复实现同一个补丁。[当前实现](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/run-host-runtime.ts:104)

本会话仍注入旧原生路径，next.read/next.wait 也重复它；临时改父 shell 变量不会改变 Host 自身保存的环境。后续在获准升级/启动窗口验证已有补丁从启动入口传到原生 Codex 调用者、Grok 子会话和 next 命令。必须用未经手工覆盖的环境做验收。

**F. 正式审查有两项接入阻断**

第一，PROFILE 校验器把模型写死为 gpt-5.6-sol/high；Grok 三角色独立仍会被拒绝。[常量与检查](/Users/luo/Documents/program/lishu-v2/.agents/skills/lishu-migration-orchestrator/scripts/profile_review.py:19)

第二，当前 delegation read 明确过滤工具调用、输出和文件活动，而项目要求协调者核验 reviewer 的实际读取证据。自报 read_files 或提供文件 SHA 只能证明引用版本，不能单独证明 reviewer 实际读取。Host 内已有 commandExecution/toolExecution/fileChange 投影，可设计显式、分页、只返回用户可见操作的 evidence/activity 视图，按需读取输出，不暴露隐藏推理或私有原生 transcript。[现有类型](/Users/luo/Documents/github/codex-host/packages/harness-adapter/src/text-session.ts:300)、[当前过滤](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/delegation-snapshot.ts:50)

当前 Grok 委派使用 always-approve；它不具备本 CLI 可选择的操作系统只读沙箱。独立 reviewer 可沿用项目已有的 prompt-enforced 零写入约束与前后验证，但必须记录真实权限模式，不能把它伪装为系统强制 read-only。

**4. 推荐的目标工作方式**

| 工作 | 默认执行者 | 交付与监督方式 |
|---|---|---|
| 搜索、调用链和故障调查 | Grok，先用已测默认 medium | 一个具名问题、一份带源码位置的短结果；完成后释放活动资源 |
| 持续实现和同 owner 返修 | Grok，复杂任务候选档位 xhigh | 一个稳定 owner 对应一个可复用任务＋独立 worktree；提交完整批次 |
| CODE 审查 | 新建独立 Grok reviewer，候选档位 xhigh | 固定候选、独立读源、结构化 findings 与实际证据 |
| legacy 语义审查 | 另一个独立 Grok reviewer，候选档位 xhigh | 从旧源码合同独立追链；与 writer/CODE 不是同一任务 |
| 集成、构建和 V2 HTTP | 专用 Grok 集成任务 | 继续执行现有 lease、fixture/target/readback/cleanup 和单一 ledger 规则 |
| 最终协调、真实合同冲突、经确认的难题 | 当前协调者，必要时才使用 Codex 执行 | 读取简短增量与可核验产物，避免重新完成整段调查/开发 |

xhigh 作为复杂角色的初始配置建议，依据是配置生效和小型审查实验，不是已经证明它优于 medium 或足以独立完成全部 W7。逐类试点后再调档位，不将 Grok 的 xhigh 与 Codex 的同名档位视为质量等价。

创建使用 codexhost-delegation；同 owner 返修继续原任务，不反复复制上下文。CODE/legacy 必须用新独立任务，不能 fork 实现者对候选的推理历史。可用实际 thread ID 作为 actor 身份，记录 harness、实际模型/档位和候选绑定。Grok 暂时不可用时不自动升级成一批 Codex writer/reviewer；先处理确证的 Host/输入/资源故障，再决定最小必要升级。

第一批并发从已测的 3 个不冲突任务开始校准，之后依据实际 Grok 容量、内存、冲突图和服务资源提高；不把原生子代理槽位当成 Grok 容量，也不因同数据库就全部串行。

**5. 分阶段改造与验收**

| 顺序 | 具体改动 | 主要位置 | 完成判据 |
|---|---|---|---|
| 1：创建与恢复可靠性 | 核验已有 CLI 路径修复；创建 single-flight/失败恢复；补 follow-up 状态更新；稳定取消/失败身份 | run-host-runtime、delegation CLI/coordinator、MappingStore、external-thread repository/runtime、Grok adapter | 并发相同请求只产生一个可读取结果；失败后无不可管理 creating；续接 list/read 一致；失败/取消后 ID 稳定 |
| 2：任务可安全接管 | 区分 cancellation request、Turn terminal 与作业静止；增加明确的 session drain/close/reconcile 能力及恢复边界 | Grok ACP transport、external runtime、delegation types/API | 有界 shell 被停止或明确报告仍活动；不能报告资源已释放却发生迟到写；已提交副作用继续走 owner 恢复 |
| 3：降低协调成本并补证据 | 紧凑 status；按 revision 的 wait-many；显式结果读取；公开 activity/evidence；恢复后可查询实际模型/权限/cwd | delegation types/CLI/server/registry/coordinator/snapshot；复用 Host 事件与用户可见 item | 多任务一次等待；未变化不返回完整旧结果；工具读取与测试输出可核验；不读取隐藏推理或私有 transcript |
| 4：改迁移执行政策与校验 | 将固定 Terra/Sol 改为 profile 声明的真实角色执行配置；双审仍独立；receipt 严格回显实际派发 | 下表所列 lishu-v2 文件 | Grok 合规输入可通过结构校验；错模型、伪造模型、同 actor、自报读取、证据漂移仍被拒绝 |
| 5：真实迁移试点 | 选择一个合同完整、写边界清楚的 owner 批次，Grok writer＋两位独立 Grok reviewer＋集成任务 | 原 canonical worktree/ledger/租约路径 | 本地测试、真实 V2 HTTP、读回/清理、双审全部完成；记录协调调用与 Codex 介入原因，再扩大范围 |

步骤 1 与迁移 policy 的方案设计可以并行；大规模 writer 派发等创建恢复可靠后再开展。正式 Grok 双审需要步骤 3 的证据接口和步骤 4 的校验合同同时就绪。资源接管不得绕过步骤 2。

建议新增的 CLI 形状如下，**这些是待设计接口，不是当前可运行命令**：

- delegate start 增加显式 cwd 和 task-file/stdin，减少目录错绑与长提示拼接；独立 worktree 仍优先由现有 Git 路径准备，不让 Host 自建第二套 Git 管理器。
- thread status / read 的紧凑模式返回 thread/turn/revision、真实配置、状态与具名阻断；默认不重发旧正文。
- wait-many 或等价批量 wait 以每任务 revision 等待变化，只在需要时另取完整 result。
- send 增加请求身份与目标轮次核验；需要运行中改方向时明确采用哪个语义。当前 Desktop steering 是取消旧轮再启动新轮，必须先解决作业残留，不能宣称它等价于原生 interject。
- 活动日志、实际配置、session 释放/恢复、孤立 creating reconciliation 提供受支持入口。空闲 Session 的释放保留历史和 worktree，不把完成、归档、删除混成一个动作。
- 手动 compact、fork、队列、远程 Host 路由按真实需求后续补；它们不是第一版 Grok writer 能运行的前置。不要为替代方案先构建一整套新的调度平台。

**6. lishu-v2 的精确修改范围**

| 文件 | 改造内容 |
|---|---|
| [AGENTS.md](/Users/luo/Documents/program/lishu-v2/AGENTS.md:48) | 默认派发与模型政策改为 Grok；保留独立 worktree、writer/reviewer 分离、证据与共享资源要求 |
| [orchestrator SKILL.md](/Users/luo/Documents/program/lishu-v2/.agents/skills/lishu-migration-orchestrator/SKILL.md:35) | 统一优先调用 codexhost-delegation，定义普通续接、独立审查与按需升级 |
| [parallelism-and-leases.md](/Users/luo/Documents/program/lishu-v2/.agents/skills/lishu-migration-orchestrator/references/parallelism-and-leases.md:54) | 将 create_thread 专属基线参数移为载体分支；补真实 parent/request/turn 绑定、busy、drain、状态与证据采纳 |
| [profile-review-contract.md](/Users/luo/Documents/program/lishu-v2/.agents/skills/lishu-migration-orchestrator/references/profile-review-contract.md:78) | 从固定 Sol 字面量改为 profile 角色要求 ↔ 实际派发 ↔ receipt 回显 |
| [profile_review.py](/Users/luo/Documents/program/lishu-v2/.agents/skills/lishu-migration-orchestrator/scripts/profile_review.py:239) | 读取声明策略并严格比较；保留三 actor 独立与所有候选/artifact 绑定 |
| [profile.schema.json](/Users/luo/Documents/program/lishu-v2/.agents/skills/lishu-migration-orchestrator/profiles/profile.schema.json:91)、[migration_profile.py](/Users/luo/Documents/program/lishu-v2/.agents/skills/lishu-migration-orchestrator/scripts/migration_profile.py:48) | 增加一份明确的角色执行策略结构，禁止缺失/混用 Harness、模型、思考档位 |
| [W7 migration-profile.json](/Users/luo/Documents/program/lishu-v2/docs/migration/post-core-4week-v1/weekly/W7/migration-profile.json:58) | 为新派发声明 Grok 角色配置；不改写已有 proof 所绑定的历史 profile 字节 |
| [W7 执行入口](/Users/luo/Documents/program/lishu-v2/docs/migration/post-core-4week-v1/weekly/W7/09-goal-execution-prompt.md:18) | 同步默认载体和档位，避免旧执行提示重新派发 Codex |
| [通用 delegation skill 生成源](/Users/luo/Documents/github/codex-host/packages/host-runtime/src/delegation-skill.ts:23) | 跟随新 CLI 能力更新命令发现、状态/恢复与证据读取指引；迁移 skill 不复制整份命令手册 |

现有 PROFILE dispatch 字段为 model/reasoning_effort；建议保留已有命名并增加 harness，明确从 Host 返回的 effectiveThinkingOptionId 映射。执行策略只维护一份，具体放置结构由实现时根据现有 profile 消费者确定，不同时增加多份角色策略文件。

历史 SLICE、旧 Sol receipt 和冻结审查记录保持原绑定，不统一文本替换。缺少新执行策略的旧 profile 若继续受支持，应采用明确的 legacy schema/version 路径，而不是静默把旧 receipt 当 Grok 结果。新的 Grok receipt 绝不能伪装成 Sol；policy 变更后对旧 proof 的采纳仍按实际无影响判断与原绑定执行。

最小校验测试：Grok 三独立 actor 正例；profile/dispatch 不符；dispatch/receipt 不符；相同 actor；缺 harness/档位；模型名伪装；配置不同却复用 request-id；旧 Sol 合法输入兼容；候选/HTTP artifact/source hash 漂移拒绝。测试源码和结构校验通过仍不能替代正式语义审查或 V2 HTTP。

**7. 验收、推广与回退**

- 保留本报告的并发创建、活动命令取消、Turn ID、列表续接和增量读取实验，作为 Host 回归的直接验收输入；补自动化测试时先复现这些真实行为。
- 新 Host 在隔离运行环境中验证后，再在明确启动窗口切换当前桌面进程；先验证一个任务及其 Grok 子调用环境，再扩展并发。
- 先做一个真实 owner 批次的 Grok 全链路，再连续验证同 owner 返修、跨组已提交合同消费和一次故障恢复。固定相同工作范围，记录每批 Codex 推理/协调介入次数、重复传回字节量、Grok 运行耗时和返工原因；实际额度采用可观察账户记录，不从 thread 数推算。
- Host 升级回退保留旧可运行构建和原任务映射；迁移策略回退只影响新派发，不改写历史 receipt。旧 writer 活动命令未核清时不能再派新 writer 接管同一资源。
- 不默认停用全部 Codex 能力；Grok 成为默认执行选择，确有不能解决的问题时再明确选择最小 Codex 升级范围。正常调研和代码返修不自动回到 Codex。
- 仍未验证：Host 实际重启/进程崩溃恢复、嵌套 Grok 委派、超过 3 的并发容量、长上下文/compact、审批交互、跨 Host、持续数小时的 writer、完整 Java/Gradle/PG/V2 HTTP 迁移及账户额度节省。这些不因本轮合成实验通过而获得 PASS。

**8. 本轮任务、残留与复现**

| 任务 | delegationId | 最后可见 turnId | 状态 |
|---|---|---|---|
| [Host 只读调查](codex://threads/f540ec41-5d6a-4956-871b-b64eaa15cc10) | aa290ca4-113f-46bc-8013-0ea341e40e60 | 2a029d04-6e5e-4392-b642-eb89c622ef7c | completed |
| [迁移合同调查](codex://threads/078db67a-b02d-4e12-a55a-822e03da0b2a) | f330b18e-d4ba-429f-b0ec-2ece29afb80e | 8bdb0d67-0964-47f7-8180-590f86912eec | completed |
| [合成 writer](codex://threads/f7a1cc32-e8cf-4d1f-911e-a03bbfdbab6c) | 9c601ed3-7c53-4aa1-b8c1-c362ccc7b218 | fefe45ea-7a17-4ccb-a56d-be5a9be4e929 | completed |
| [独立 reviewer](codex://threads/907492ae-1b62-4654-87d2-67d2ecd2a2ec) | f97d0848-36d1-4210-8d0e-839512514ce2 | 4a808785-59c7-42cd-b6a5-5926613a1edf | completed |
| [取消与续接](codex://threads/be4e7c2d-4836-4127-bcd5-d027d2319cd6) | 6fef99bb-457d-4c3b-970a-313a0feaa443 | e0bc467d-426b-4d63-a190-1a1d6d70fed3 | completed |
| [并发失败孤立记录](codex://threads/67308aba-8ce7-48ca-9ca8-eb6da79638f6) | e8ae4aed-ba35-4953-a248-22442610a1f2 | pending（没有可确认真实 Turn） | creating，read/cancel 失败 |

**已知残留：** 并发实验产生的上述 creating 元数据没有可用 CLI 清理入口，保留用于后续恢复修复；没有手工改 Host 存储掩盖失败。取消实验的 Python 进程已自然退出，late.txt 作为证据保留。其余本轮可读任务均已完成，未删除历史或 worktree。

[原始证据目录](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/evidence) 包含命令 argv、cwd、退出码、响应正文与耗时；调用环境的端点令牌未写入。源码调查的 Grok 返回也保留在 evidence 中，其中关于“AGENTS 存在 gpt-5.4-high 默认冲突”的一句没有在本次仓库检索中复核到，未采纳到本报告结论。

[合成仓库 bundle](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/fixtures/synthetic-worktrees.bundle) 保留 baseline、codex/grok-writer 和 codex/grok-review 三个分支；可克隆后按对应分支运行 python3 -B -m unittest -v。codex/grok-writer 应 9/9 通过，codex/grok-review 应有 2 个预期失败。probe.py 和 cancel_probe.py 仅为本轮实验材料，其中路径和已使用的 request-id 需要在再次实验时重新绑定；不要直接重放到业务 worktree。
