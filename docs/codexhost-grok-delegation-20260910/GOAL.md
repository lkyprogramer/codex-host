/goal
GOAL:
基于 /Users/luo/Documents/github/codex-host 的 local/all-fixes@80f3116530c47e05ec24b97f267c011bbf7be982 完成 Grok 委派可靠性、低重复输出与证据接口，并以一个经过独立审查、真实 Grok 验证和 CI 的普通上游 PR 交付 Host 通用改动。

CONTEXT:
- 计划入口：docs/codexhost-grok-delegation-20260910/README.md、EXECUTION.md、TEST_MATRIX.md、PR_PLAN.md、state.json 和当前 task 文件。
- 调研依据：docs/2026-09-10-codexhost-grok-delegation-vzlus9t3/REPORT.md 及 evidence；npm CLI 修复已由 docs/codexhost-grok-delegation-20260910/evidence/npm-path-next-read.json 复验通过。
- 开发源：/Users/luo/Documents/github/codex-host，固定基线 80f3116530c47e05ec24b97f267c011bbf7be982；保留已修复的 CLI、Windows shell 和分页行为。
- 唯一开发仓库为 codex-host；写前读取该仓库 AGENTS。允许在其独立 worktree 与合成测试目录工作，不修改任何消费项目的代码、规则或配置。
- 上游 BytePioneer-AI/codex-host:main；贡献 fork lkyprogramer/codex-host；既有依赖 #223/#233，开始与发布前查当前状态。

CONSTRAINTS:
- 只执行当前 task 的源码、直接测试、必需文档及生成物，禁止无关清理。当前基线是用户明确要求，不得切回旧 origin/main。
- Verification integrity: do not weaken or bypass tests, assertions, lint, typecheck, validation, generated-output checks, or external blockers to make the goal pass; fix the root cause or report the blocker.
- 遵守 repository instructions；保留用户 tracked/staged/unstaged/untracked 改动，使用独立 worktree 与本地可恢复提交，不强推或重写已共享历史。
- 优先 codexhost-delegation + Grok。writer/两个 reviewer 为独立真实 actor；只读任务不授予写权限，不把 always-approve 宣称为只读沙箱。
- 不读取/打印/提交 secrets、credentials、令牌或私有原生 transcript；公开 PR 不包含私有项目路径/合同/数据/本地内部报告。
- 此计划启动后的授权包括本地实现、隔离真实 Grok 测试、本地提交、向本人 fork 的本计划分支 push，以及创建一个普通 PR；不包括 merge PR、tag、release、部署安装包、重启现用 Host、生产或远端数据访问。
- 涉及 Host 元数据恢复先 dry-run；只在本计划独立测试存储验证写入和回退，不直接修理现用孤立记录。
- 维护 state.json 为本计划执行状态，只记录 codex-host 的任务与证据，不伪造验证结果。

DONE WHEN:
- T01 至 T08 的任务完成、测试矩阵每个 required case 有候选/真实命令/日志与结果；T00 已验证基线未回退。
- 并发创建无重复投递或不可管理孤立记录；Turn 身份与 list/read 一致；取消与作业静止明确区分，未证实静止时不能释放资源。
- Grok 可在独立目录开发/测试/提交，由另两个任务独立审查；Host 通用技能正确使用真实配置、稳定任务身份、增量等待、恢复和独立审查。
- 无变化的批量等待不重发历史正文；实际配置和用户可见工具证据可被定向读取，隐藏推理不暴露。
- codex-host 通用变更从指定基线向前集成，最终 ordinary PR 已指向 BytePioneer-AI/codex-host:main。
- PR 当前 head 的 required CI checks 成功；若 CI/上游权限或必要运行证据未完成，保留 PARTIAL/BLOCKED，不宣称本 goal 完成。

VERIFY:
- 每 task 执行其中列出的定向命令；最终运行 npm run check，并保存运行版本、基线、候选、输出和退出码。
- 用计划新增的 tools/delegation/verify.mjs 执行 TEST_MATRIX.md 所列 required scenarios；其入口实现前不得把示例命令当可用工具。
- 执行 Host managed skill 的直接测试、技能结构检查和实际 Grok workflow 试验；hermetic 与真实 Grok 证据分层记录。
- 检查 codex-host 最终 committed/staged/unstaged/untracked 内容、上游 diff 和公开信息边界。
- 创建 PR 后检查 gh pr view 和 gh pr checks；将 URL、head SHA、CI 结果写入 state.json。

OUTPUT:
- codex-host 的完整提交范围、实际修改路径、重要合同决定及 blast radius。
- 分阶段 evidence、失败根因与定向修复记录、隔离测试清理/残留结果。
- 上游普通 PR URL、准确的 Summary/Why/Changes/Scope/Validation/Risk & Rollback/Related 正文。
- 真实未验证项、外部阻断、回退方法和必要后续；不要给未测额度节省比例。

STOP RULES:
- 不为 ordinary 本地实现反复询问；缺少 secrets/production 权限、破坏性操作、真实公共合同冲突、共享写冲突或用户改变范围时，只阻塞依赖该条件的步骤。
- 同条件失败两次且无新证据，停止相同重放并转根因诊断；取消、超时、UNKNOWN 先核对原任务与副作用，不换 request-id 盲重试。
- 不用 npm start 测试现用桌面，因为它会停止桌面进程；隔离 Host 无法建立时记录精确 blocker。
- 不自动删除旧 session/worktree/历史 receipt；无法证明资源静止时保留占用。
- 达到 DONE WHEN 后停止，不额外扩展远程 Harness、UI、消费项目接入或模型排行榜。

