# T09 — 从当前修复基线交付普通上游 PR

依赖：T08。Owner：唯一集成者。严格按 /Users/luo/Documents/codexPlans/codexhost-grok-delegation-20260910/PR_PLAN.md 执行。

## 任务边界
目标 BytePioneer-AI/codex-host:main；通过本人 fork lkyprogramer/codex-host 的 codex/delegation-grok-workers 分支提交。开发提交从 80f3116530c47e05ec24b97f267c011bbf7be982 继续，不为了 PR 改用旧 main 基线，不丢 CLI/分页等已修复内容。

公开内容只包含 codex-host 通用源码、直接测试、匿名化合成用例和通用文档。其它项目内容、私有源码路径、内部报告/plan/evidence、账号凭据不得进入 PR。已知基线修复分别关联 #223/#233，与本轮新增 commits 区分。

## 执行
1. 查当前 origin/main 与 #223/#233 状态；保留用户指定开发基线。需要跟上上游时向前 merge 到本计划分支并解决实际冲突，不 reset/rebase 已共享历史。
2. 核对本轮完整 commit range 与上游 PR diff，写清仍展示的既有依赖。不能把基线未上游造成的 diff 当作本轮新实现。
3. 验证公开文件集、secret/内部路径未泄露、无临时输出。PR_BODY.md 根据最终候选重写，所有字段有实际内容或 N/A，不能预填测试成功。
4. 检查 fork 分支是否已属于本计划；存在不明分支时不 force push，先确认或选择新的 codex/ 分支并更新绑定。
5. 向 fork push 本计划分支；用 gh pr create --repo BytePioneer-AI/codex-host --base main --head lkyprogramer:codex/delegation-grok-workers --title <最终标题> --body-file <正文文件>。不得 --draft，不合并 PR。
6. 已有同 head/base 的 PR 时更新它，不重复创建。记录 URL、head SHA、base、依赖、文件集和检查结果。
7. 查看 required CI，失败时修根因并只提交本范围修复；外部配额/权限故障具名记录，不能冒充 CI 通过。

## 测试与完成
PR-01：PR 是普通 OPEN、目标仓库/base正确、head为本计划提交。
PR-02：最终上游 diff 无其它项目/私密/无关新改动，已有修复依赖披露完整。
PR-03：required CI 与 T08 证据覆盖当前 head；必要冲突解决后重验影响闭包。
PR-04：codex-host 完整提交范围可恢复，源 worktree/证据保留，未部署和未合并的状态如实报告。

用户启动完整计划后，fork push 与普通 PR 是其明确要求的最终交付，不另起重复审批；它不授权 force push、上游 merge、tag/release或重启现用桌面。

