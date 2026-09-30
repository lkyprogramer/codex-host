# 上游对比研究工作记录

- 目标：对比当前定制 fork 与上游最新 main / release，交付按价值、风险、依赖排序且可供 AI 实施的改造清单。
- 范围：只读研究两个仓库；仅在本目录编写研究文档。不修改业务代码、不启动 Desktop、不安装、不提交或推送。
- Fork：`/Users/luo/Documents/github/codex-host`，`feat/process-anchor`，`af255febcba902a70d16cfec9271dfa2c5cd6ae9`。
- Upstream：`/Users/luo/Documents/github/codex-host-ori/codex-host`，`main`，`997f62a0ede22609ed42b949957100d16043ad17`。2026-09-26 通过 `git ls-remote` 核对远程 main 同值。
- Release：GitHub release 页面与本地 tag 并行核对；发布说明用于发现线索，源码与测试用于判断可借鉴性。
- 用户后续收窄：排除其他 Harness 的 Session 历史导入；排除多账号、凭据导入、额度刷新/展示/门控改造。已管理会话的历史读取、fork/revise 与子任务冷恢复继续在范围内。
- 优先级：底层可靠性 / 架构 / 已有能力完善 / 新产品功能优先，新增 Harness 最后。

## 独立研究包

派发请求为 GPT-6 Sol / high，但后续核验发现默认角色固定为 Sol / medium；此前 high 的标注不能作为实际执行档位证明。子代理只写自己的研究结果文件，不修改代码或其他文档。

| 包 | 负责范围 | 输出 |
| --- | --- | --- |
| native-update | Rust launcher/shim/platform/updater、进程与 IPC、更新/打包/跨平台 | `native-update.md` |
| protocol-runtime | Host runtime、protocol、mapping、Harness 公共合同、连接/历史/生命周期/插件加载 | `protocol-runtime.md` |
| desktop-renderer | Desktop control、Renderer、Composer、设置与交互功能 | `desktop-renderer.md` |
| existing-harnesses | 已有 Adapter 的可靠性、原生语义与能力；新 Harness 仅列低优先级 | `existing-harnesses.md` |
| integration | 主代理：分叉与 release 清单、架构/测试边界、证据复核、去重、排序和实施卡 | `README.md`、`evidence.md` |
| final-review | 独立检查高优先级判断、证据、重复工作、实施卡可执行性 | `review.md` |

## 整合与验证

每项建议须记录：上游证据、fork 当前等价物或缺口、收益、推荐迁移方式、定制冲突、依赖、最小实施范围、验收条件、风险与回滚。明确区分代码事实、设计推断与未验证运行行为；不把已有能力重复列为缺失。优先移植语义与定向修复，不做整树覆盖或批量 cherry-pick。检查文件路径、提交、release 和建议测试命令；本轮不运行产品构建或运行时验收。

状态：研究与文档交付完成。独立复核抽查范围内无剩余明确问题。

## 最终整合结果

- 接受：35 个工作包，17 P1 / 14 P2 / 4 P3；README 的矩阵与 tasks.md 的 ID 一致。
- 排除：按用户后续要求，Session 历史导入、多账号/owner-pool 改造、凭据导入、额度展示/刷新/门控退出队列；U11/U21/U36/U38 保留空号，不生成任务卡。
- 保留：fork anchor、owned-process、resourceLifecycle、delegation/observer、capability、conformance、边界检查和既有账号行为。
- 复核修正：补完整大历史 JSONL + WebSocket 两处边界；不重复实现 fork 已有 Usage 重订阅；权限继承不得照搬吞错；CodeBuddy scope 区分静态与原生证据；纠正 U05 下游依赖文字。
- 结果文档：README.md 为统一决策与优先队列，tasks.md 为实施合同；四份分域报告是源码依据，evidence.md 是固定版本与来源，review.md 是独立抽查记录。

## 已执行的验证

- Git：两仓库 HEAD、共同祖先、独有提交计数、文件树差异；远程 main/tag 和 GitHub release 元数据核对。
- 文档：任务 ID/矩阵一致性、排除项检查、本地链接目标、GitHub commit 链接对应 Git object、逐文件 whitespace 检查及本目录 Prettier 检查。
- 范围：原有 tracked 文件无 diff；上游工作区仍干净；新增仅本研究目录。未 fetch/checkout/merge、未提交或推送。
- 未运行：产品单元/集成/E2E 测试、TypeScript/Rust 构建、真实 Harness/Desktop/SSH、安装更新、CI 和目标平台 smoke。卡中的命令均是后续建议。
