# T08 — 集成候选验证与独立审查

依赖：T07。Owner：协调者/集成者。两个 reviewer 必须是未实现本候选的新 Grok 任务。

## 范围与步骤
1. Host 从指定 80f3116 基线向前集成 T01–T07 的全部提交。记录完整 base..delivery，不丢基线修复、不带用户无关 WIP。
2. 固定候选后执行 TEST_MATRIX.md。已有证据内容闭包未变可明确采纳；变化场景必须重验，不能只引用旧聊天 PASS。
3. 场景 FLOW-01：真实 Grok writer 在合成独立 Git worktree 读合同、修改代码、测试、提交；代码与公共合同 reviewer 各自新任务审查冻结候选；至少一个已知负例被检出。所有 actor、活动证据和真实配置可核验，测试期不调用 Codex 模型执行者。
4. 场景 FLOW-02：释放/重启隔离 Runtime 后恢复同 child，读取历史/继续任务且配置不漂移；处理一个响应丢失与原 request 的恢复，不二次提交 target。
5. 场景 FLOW-03：连续多个增量等待周期，统计调用次数、重复正文 bytes、Grok task 数及 Codex 介入；不推算订阅扣费比例。
6. 两个独立 reviewer 分别检查代码正确性/兼容性，以及操作语义/恢复/证据完整性；核对真实 Host/CLI/Grok 结果与冻结候选，不能只做“源码存在”审查。
7. 返修交原 writer；冻结新候选，只重验实际受影响闭包。全部 required gate 满足后形成 FINAL-AUDIT.md。

## 验证命令
Host：npm run check（使用 .node-version、packageManager 指定工具链）；新增入口分别以 --mode hermetic 和 --mode live 执行 --scenario all-required，保存各自原始结果和清理回执。
Host 技能：T07 所列 managed skill 直接测试、结构检查与真实行为前测。
Git：git diff --check；git status --short --branch；git diff <BASE>...HEAD --stat；完整 tracked/staged/unstaged/untracked 交付检查。

## 完成
TEST_MATRIX required cases 有可验证结果；两个独立审查没有未解决 P0/P1；新 CLI/skill/schema/文档一致。全量 check 环境故障不能假称通过，精准报告后修复环境或将该 gate 保留未完成。

验收仅使用 codex-host 与合成隔离工作区，证明通用委派、恢复和证据能力；不要求修改或接入任何消费项目。
