# 上游 PR 交付方案

## 基线和依赖
开发始终从当前源码 local/all-fixes@80f3116530c47e05ec24b97f267c011bbf7be982 开始，包含既有 BUG 修复。
上游目标 main；本计划时已查询 GitHub：无上游 push 权限，fork lkyprogramer/codex-host 可用于贡献。#223 的 head 为 405dae62e153f921d19e9d65039f01efa4a2a018，含 npm 修复；#233 是 Account 分页。发布前重新读取实际状态。

不重写或重复实现这些修复，不因 PR 整理删除它们。若依赖尚未合入，上游普通 PR 可以显示相关基线差异，但正文必须列出 Depends on #223 / #233、说明其既有提交和本轮增量。依赖合入后通过向前合并上游 main 收敛 diff；禁止擅自 force push 或 reset。确有超出这两项的基线差异时逐项识别其来源，不带入无关新修改。

## 最终形式
一个普通上游 PR，建议最终标题按实际交付重写为：
feat: support reliable Grok delegation workers and verifiable coordination

提交按 task 保持可审阅：隔离测试入口、创建恢复、Turn控制、Session静止、观察输入、活动证据、通用技能文档。不要把所有过程修修补补都写入正文。
所有开发提交均属于 codex-host，本计划只有这一仓库的交付。

## 发布前检查
- 固定最终 head，T08 已通过；上游 diff 逐文件检查。
- 公开材料使用 generic fixture/relative paths，不包含本地 /Users/luo、私有项目数据、内部报告或真实登录信息。
- 使用 body-file 保留正文真实换行，不把 Markdown 拼接进 shell。
- 创建 ordinary PR，缺项填 N/A。本计划中的模板不是已完成声明，T09 必须改成实际结果。
- 创建后核对 URL/repo/base/head/非 draft/CI；不自动 merge、发布或部署。

## PR 正文模板
以下保留应用要求的结构。生成实际 PR 时删除“待执行”并填真实证据；尚未测则必须明确未测。

### Summary
使外部 Harness 委派支持可恢复的创建、稳定任务控制和可核验的协调。（按最终代码修订）

### Why
并发创建可能留下不可管理记录；取消回合不证明工具作业已停止；协调方缺少紧凑状态与操作证据。

### Changes
- 待执行：列出实际实现及对应文件/行为，不写“优化一些代码”。
- 待执行：说明实际保留的兼容行为和新 CLI 参数。
- 待执行：列出真实测试入口及新增正反例。

### Scope
- 影响模块：待填 Host Runtime / MappingStore / Grok Adapter 的实际范围。
- 影响接口：待填已实现 CLI/API。
- 影响数据/配置：待填存储兼容及恢复策略；无则 N/A。
- 是否有破坏性变更：待验证，必须据实填写。

### Validation
- 自测方式：待执行，按实际命令填写。
- 测试结果：未测（计划阶段）。
- 未覆盖项：待填真实环境和平台限制。

### Risk & Rollback
- 风险点：持久化恢复、取消/进程所有权、原生历史身份及结果可见性。
- 回滚方案：保留前版构建与存储兼容；实际 schema 变化按最终实现给出可验证方法，不仅写 git revert。

### Related
- Issue: N/A
- Spec/Doc: 上游仓库内实际新增的通用设计/CLI文档；无则 N/A。
- Prerequisites: #223、#233（发布时复核并更新）。

实际 PR 使用 ## 标题层级；本地模板嵌套层级不约束 PR 渲染。

