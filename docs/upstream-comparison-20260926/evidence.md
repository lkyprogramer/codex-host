# 比较基线与证据说明

## 固定版本

研究日期：2026-09-26（Asia/Shanghai）。结论只适用于下列源码快照；后续实施前重新核对 HEAD 和目标文件。

| 项目 | 当前 fork | 原始上游 |
| --- | --- | --- |
| 路径 | `/Users/luo/Documents/github/codex-host` | `/Users/luo/Documents/github/codex-host-ori/codex-host` |
| 分支 | `feat/process-anchor` | `main` |
| HEAD | `af255febcba902a70d16cfec9271dfa2c5cd6ae9` | `997f62a0ede22609ed42b949957100d16043ad17` |
| package version | `0.7.0-local.11` | `0.10.1` |
| 起始工作区 | 干净 | 干净 |
| package license / LICENSE | MIT | LGPL-3.0-only / LGPL v3 |
| TS workspace packages | 21 | 26 |
| Adapter packages | 10 | 15 |
| `crates/*` 产品 crate | 5（含 anchor） | 4 |

共同祖先为 `7cc4db87fe5e5aa7f232e592a6ff8f0ff96534c9`（`chore: prepare v0.7.0`，2026-09-12 00:10:33 +0800）。`git rev-list --left-right --count` 显示 fork 独有 106 个提交、upstream 独有 428 个提交。这里包含 merge、文档和测试提交，不能解读为 428 项新功能，也不能用提交归属判断 patch 是否已被 fork 等价实现。

使用 `--no-renames` 比较 fork HEAD → upstream HEAD：611 个 A、397 个 M、253 个 D。A 表示只在上游树中，D 表示只在 fork 树中；包含目录重组、文档、skills 和证据文件，**不是生产缺口数量**。上游新增的 5 个 Adapter 包为 Hermes、Kimi Code、Qoder、Qoder CN、WorkBuddy；Qoder 两个发行包不应算成两个独立架构方向。

本轮只临时通过 `GIT_ALTERNATE_OBJECT_DIRECTORIES` 读取另一仓库的 Git object，没有 fetch、checkout、merge 或移动任何 ref。

## 最新上游核验

已实际运行：

```bash
git ls-remote https://github.com/BytePioneer-AI/codex-host.git HEAD refs/heads/main refs/tags/v0.10.1
git -C /Users/luo/Documents/github/codex-host-ori/codex-host rev-parse 'v0.10.1^{}'
env GIT_ALTERNATE_OBJECT_DIRECTORIES=/Users/luo/Documents/github/codex-host-ori/codex-host/.git/objects git merge-base HEAD 997f62a0ede22609ed42b949957100d16043ad17
env GIT_ALTERNATE_OBJECT_DIRECTORIES=/Users/luo/Documents/github/codex-host-ori/codex-host/.git/objects git rev-list --left-right --count HEAD...997f62a0ede22609ed42b949957100d16043ad17
```

远程 HEAD/main 都是 `997f62a0…`。`v0.10.1` 是 annotated tag，tag object 为 `c6279a6e…`，peel 后才是同一个 `997f62a0…` commit，不是版本错位。通过浏览工具读取 [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases)，并通过 GitHub public API 获取 release 元数据和说明交叉核对。

## Release 覆盖矩阵

以下是本轮研究摘要，不是发布说明原文；源码和测试证据见各分域报告与主清单。

| Release | GitHub 发布时间（UTC） | 与 fork 的相关主题 | 整合原则 |
| --- | --- | --- | --- |
| [v0.7.1](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.7.1) | 2026-09-12 02:58:03 | Desktop 26.908 request-manager / Composer 兼容 | fork 已有相关修复，核对语义后避免重复移植 |
| [v0.8.0](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.8.0) | 2026-09-13 16:34:11；prerelease | 多账号探索、账号额度渐进加载、Claude 后台任务、OpenCode cwd | 只采用最新代码仍保留且 fork 缺失的结果，不能机械采用随后回退的中间方案 |
| [v0.8.2](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.8.2) | 2026-09-14 14:53:09 | 上游撤回 Host 托管 Codex 多账号 | 视为产品定位变化，不能直接删 fork 定制 |
| [v0.9.0](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.9.0) | 2026-09-16 16:38:31 | 文件 diff 汇总、原生导入、资源页、SSH、插件加载、模型收藏 | 生命周期与插件加载先做去重；导入/性能/原生边界作为候选 |
| [v0.9.1](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.9.1) | 2026-09-19 16:50:08 | Cursor/CodeBuddy 原生能力、OMP 交互与迟到事件、Node PATH | 既有 Harness 修复优先；新增 WorkBuddy/Hermes 最后 |
| [v0.9.2](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.9.2) | 2026-09-22 16:55:06 | 连接与 Composer 路由分离、活跃目录优先、Claude 模型、Pi 子任务 | 重点分析跨层耦合与增量加载，不复制名称分支 |
| [v0.10.0](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.10.0) | 2026-09-23 15:51:36 | 外部 Harness 额度隔离、稳定注入、工作区命令/技能、更新反馈、fork 权限继承 | 高价值现有链路修复先行；命令协议先于 UI |
| [v0.10.1](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.10.1) | 2026-09-25 03:37:43 | socket symlink、Pi 取消收尾、DSH 协议/历史、OMP 子任务 | 按 fork 真实使用能力和代码缺口选择 |

## 许可证事实与代码来源

上游提交 [`e81df5a1647719f582b371eda7e22a76bcb7ce3f`](https://github.com/BytePioneer-AI/codex-host/commit/e81df5a1647719f582b371eda7e22a76bcb7ce3f) 在 2026-09-22 切换许可证。当前 fork 的 [package.json](/Users/luo/Documents/github/codex-host/package.json:5) 与 [LICENSE](/Users/luo/Documents/github/codex-host/LICENSE:1) 仍是 MIT；上游 [package.json](/Users/luo/Documents/github/codex-host-ori/codex-host/package.json:5) 与 [LICENSE](/Users/luo/Documents/github/codex-host-ori/codex-host/LICENSE:1) 已不同。

这是实施前需要核对的实际来源差异，不是对本项目授权状态的法律结论。每张任务卡的“可移植”表示技术可行性；复制具体代码前记录所取提交、文件、版权/许可证与发布要求，不能把最新代码自动标为 MIT，也不能仅凭日期假定某段代码的适用许可。保留许可材料与修改记录。若采用理念重实现，同样记录来源；“重实现”本身不构成许可结论。本轮没有复制上游生产代码。

## 证据等级与完成边界

- **已观察：** 两仓库 Git/文件/配置/源码/测试定义；远程 main/tag 和 release 元数据；分域候选的具体调用路径。
- **推断：** 技术收益、冲突程度、工作量和优先级。S/M/L 仅为相对规模，不是工期承诺或性能测量。
- **未运行：** 产品测试、TypeScript/Rust 构建、真实 Harness、Desktop 渲染、SSH、安装/更新、目标平台 smoke、CI；报告中的这些命令是后续验收建议。
- 全面比较指所有主要模块和 release 主题均有归属并做候选筛选，关键候选追到源码；不是对所有变更逐行审计，也不是发布认证。
- 本轮运行的文档检查与独立复核将在 `workflow.md` 和 `review.md` 中记录。研究文档之外不应有 tracked diff。

## 可复查索引

- [上游提交索引](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/upstream-commits.tsv)：共同祖先之后全部 428 个上游提交。
- [fork 提交索引](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/fork-commits.tsv)：共同祖先之后全部 106 个 fork 提交。
- [文件树差异](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/tree-diff.tsv)：固定两端的 no-renames name-status。

- [Release 元数据索引](/Users/luo/Documents/github/codex-host/docs/upstream-comparison-20260926/release-index.tsv)：只保存自共同基线以来的 tag、发布时间与来源 URL；发布内容已概括入本页，未保留整份发布说明。
