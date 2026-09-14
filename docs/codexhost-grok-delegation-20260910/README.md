# Grok 委派替代：AI 自主开发计划

状态：计划已交付，开发尚未启动。npm CLI 路径修复已复验通过，作为既定基线保留。

目标：从当前已修复源码继续，将 codexhost-delegation 做到能够稳定承载 Grok 调查、持续 writer、独立 reviewer 和集成任务，减少 Codex 的执行负担；最终通过一个普通上游 PR 交付 codex-host 通用改动。开发范围仅为 codex-host 仓库内的源码、直接测试和通用文档。

## 直接交给 AI 的入口

读取 [GOAL.md](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/GOAL.md)，再读 [EXECUTION.md](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/EXECUTION.md)，按 [state.json](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/state.json) 的依赖领取任务。没有要求现在启动开发；这份计划本身不触发代码修改或发布。

## 已确认基线

| 对象 | 固定输入 |
|---|---|
| codex-host 开发基线 | /Users/luo/Documents/github/codex-host，local/all-fixes，80f3116530c47e05ec24b97f267c011bbf7be982 |
| 既有修复 | npm launcher、Host-provided CLI 路径、Windows shell 命令及 Account 分页修复；均属于基线，不回退、不重新实现 |
| 上游 PR 目标 | BytePioneer-AI/codex-host，main |
| 贡献路径 | 当前账号 lkyprogramer，无上游 push 权限；现有 fork 为 lkyprogramer/codex-host |
| 既有上游依赖 | PR #223 为 CLI 路径修复，#233 为分页修复；本计划生成时均未合入 |

**用户已明确指定当前源码及已修复 BUG 的基线。禁止为了整理 PR 从旧 origin/main 重开开发，禁止丢掉基线修复。** 工作分支从上述 80f3116 创建。上游 main 仅用于评估最终 PR 差异及后续向前合并，不覆盖开发基线。详见 [PR_PLAN.md](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/PR_PLAN.md)。

## npm 修复复验

本轮未覆盖 CODEXHOST_CLI_PATH，原始值已为 npm bin/codexhost.js；help、inspect、旧任务 read 成功。新 Grok 任务回报 PATH_RECHECK_OK；Host 返回的 next.wait 与 next.read 原样执行成功。[复验回执](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/evidence/npm-path-next-read.json)

- delegationId：36a49697-2822-4671-8327-27743e272cfd
- threadId：[0560586f-7af7-42ca-a278-87b1a1ba2d52](codex://threads/0560586f-7af7-42ca-a278-87b1a1ba2d52)
- turnId：04ab56dd-c46f-4f24-8071-e1cb2a066179
- 状态：completed；生效 grok-4.6 / medium。

child 内 help 退出码由 child 可见结果回报；父任务直接执行 help/inspect/next 命令的退出码已捕获。当前 CLI 仍无工具活动视图，完整 child 工具轨迹读取属于 T06。

## 任务与顺序

| ID | 交付 | 依赖 |
|---|---|---|
| T00 | [已完成基线与路径复验](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T00-baseline.md) | 无 |
| T01 | [隔离的真实 CLI/Grok 验证入口](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T01-isolated-harness.md) | T00 |
| T02 | [原子创建、幂等与孤立记录恢复](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T02-creation-recovery.md) | T01 |
| T03 | [稳定 Turn、准确状态和安全续接](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T03-turn-control.md) | T02 |
| T04 | [取消后的作业静止、释放与恢复](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T04-quiescence.md) | T03 |
| T05 | [紧凑观察、批量等待和明确输入](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T05-observation-input.md) | T03 |
| T06 | [可核验活动证据与真实配置](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T06-evidence.md) | T05 |
| T07 | [Host 委派技能与通用使用文档](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T07-host-skill.md) | T04、T06 |
| T08 | [稳定候选完整验证与独立审查](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T08-acceptance.md) | T07 |
| T09 | [最终上游普通 PR](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/tasks/T09-upstream-pr.md) | T08 |

T04/T05 虽无业务依赖，仍会修改同一组 Host 公共文件，默认由一个持久 Host writer 串行完成。独立测试/调查可由 Grok 并行执行；不为数量把共享文件分给多个 writer。

## 必须解决的已观察问题

并发相同 request-id 曾使两个创建请求都失败并留下不可管理 creating；取消回合后命令继续写文件；取消前后 Turn ID 漂移；follow-up 后 parent 列表状态滞后；增量 messages=[] 仍重发完整结果；工具证据不在 CLI 可见结果中。

[完整调研报告](/Users/luo/Documents/Codex/reports/2026-09-10-codexhost-grok-delegation-vzlus9t3/REPORT.md) 是历史实验依据。npm 路径问题已被本轮复验关闭，报告中旧路径失败不可再当成当前 blocker。当前记录的 7 个 Host 相关源码文件与调研时的 SHA256 一致；它们的故障应在 T01/T02 开始时用隔离候选重现，不能在共享运行库反复制造残留。[当前绑定](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/evidence/host-baseline.json)

## 交付边界

- 本计划的技术验收覆盖真实 Grok、CLI、Host、独立文件开发/审查、恢复与 Host 通用技能。
- 只修改 codex-host 及其隔离测试工作区；不修改任何消费项目，不重启现用桌面、不发布安装包、不合并上游 PR。
- 默认 Grok 主执行；不存在“所有 reviewer 必须耗用 Codex”这一最终设计前提。独立性、权限和证据标准保留。
- 不承诺订阅节省比例；记录非空且可比的协调调用、重复输出、实际 Harness 路由和必要 Codex 介入。目标是减少执行负担而非只减少任务数量。
- [TEST_MATRIX.md](/Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/TEST_MATRIX.md) 定义逐项验收；只有当前候选证据满足才更新 state.json。没有执行的测试保持 NOT_RUN。

