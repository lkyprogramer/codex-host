# 文档目录

README 提供使用概览；架构与运行时文档随当前源码维护；评审、验证记录和历史归档按各自基线解读。方案文档不自动代表功能已实现，文档更新也不改写此前测试收据。

## 从这里开始

| 文档 | 作用 |
| --- | --- |
| [项目 README](../README.md) | 安装、十个外部 Harness 的接入边界、协作与开发入口。 |
| [English](README.en.md) / [한국어](README.ko.md) | 与中文入口同步的功能、架构和开发概览。 |
| [贡献说明](../CONTRIBUTING.md) | Issue、PR、验证证据和 Harness 改动要求。 |
| [领域术语表](领域术语表.md) | Harness、Plugin、Capability、Model、Provider、Account、Thread 与 Native Ref。 |

## 当前架构与插件接入

| 文档 | 作用 |
| --- | --- |
| [Harness 插件架构](harness-plugin-architecture.md) | 已实现的包职责、依赖方向、动态目录、Session 生命周期、持久化和原生边界。 |
| [插件运行时](harness-plugin-runtime.md) | Manifest、启用与信任、工厂和 Session 校验、目录路由、发行与远程加载。 |
| [Adapter conformance](adapter-conformance.md) | 十 Adapter 的公共生命周期验证、唯一 outputs 消费者、期限、收据和 incomplete 状态。 |
| [Harness 接入 Skill](../.agents/skills/codexhost-add-harness/SKILL.md) | 从原生接口到插件、发行和 Desktop 的实现导航。 |
| [可执行文件发现](harness-executable-discovery.md) | CLI 发现、跨平台调用与 DeepSeek 精确版本范围。 |
| [命令接入](harness-command-integration.md) | 原生命令的 Adapter、Host 与 Renderer 职责。 |
| [ACP 接入与复用](acp-layer-follow-up.md) | 当前 Grok、Kiro、CodeBuddy、Cursor 四个实现及尚未抽取的 Transport 边界。 |
| [仓库维护自动化](repository-maintenance.md) | PR 标签、CI 结果与发布前校验。 |

## Thread、能力与各 Harness

| 文档 | 作用 |
| --- | --- |
| [外部 Thread 调整方向](external-thread-steering.md) | 原生插话与取消后重启的区别、官方 Codex 回退及提交边界。 |
| [Thread observer](thread-observer.md) | 事件过滤、续等、结果观察和外层等待限制。 |
| [原生会话导入](harness-session-import.md) | 本地 Pi / DeepSeek 导入的公共合同与恢复事务。 |
| [账号](codex-accounts.md) | Codex 账号及 Harness 只读额度的产品边界。 |
| [Subagent 状态与 Model](subagent-status-and-model.md) | 原生子代理身份、状态、只读历史和后台生命周期。 |
| [Pi 消息修订](pi-edit-recovery.md) | Pi 原生历史与消息编辑恢复。 |
| [Claude Plan](claude-code-plan-mode.md) / [消息修订](claude-code-edit-recovery.md) | Claude 权限计划流程与原生恢复语义。 |
| [Grok Plan / Steer](grok-plan-and-steer.md) | Grok ACP 的 Plan、插话和权限范围。 |
| [OpenCode 接入](opencode-harness-integration-analysis.md) / [消息修订](opencode-edit-recovery.md) | SDK / Server、配置确认、历史派生及验证限制。 |
| [DeepSeek 消息修订与恢复](dsh-edit-recovery.md) | 两个支持版本的停止确认、Fork 与 V0 / V3 checkpoint 隔离。 |
| [Antigravity 权限](antigravity-tool-approval.md) / [子代理](antigravity-subagents.md) | Skip permissions、原生交互与观察边界。 |
| [Kiro Adapter](../packages/adapters/kiro-cli/README.md) | ACP 配置确认、权限与取消、并发交互、close 和 conformance。 |
| [CodeBuddy 接入](codebuddy-harness-integration.md) | ACP、原生配置、无人值守策略与历史能力限制。 |
| [Cursor 实验接入](cursor-cli-experimental.md) | 动态目录、原生 ACP / SQLite、Diff 与尚未认证的版本边界。 |

## 安装、远程与平台

| 文档 | 作用 |
| --- | --- |
| [Linux 中文](linux.zh-CN.md) / [English](linux.md) | x64 / ARM64 Linux 安装、进程所有权与诊断。 |
| [SSH 中文](remote-ssh-host.zh-CN.md) / [English](remote-ssh-host.md) | 远端插件目录、原生执行、listener 停止与安全卸载。 |
| [Remote Control 中文](remote-control-host.zh-CN.md) / [English](remote-control-host.md) | 官方配对通道上的被控 Host 集成。 |
| [Aqua Broker](native-aqua-broker.md) | 原生承载、故障终结与 fresh resume、generation 恢复。 |
| [macOS 原生工具](macos-native-tools.md) | macOS 原生执行与平台集成。 |
| [Windows 工具兼容](windows-tool-compatibility.md) | Windows Harness 子进程、命令与工具兼容。 |
| [Desktop 升级诊断](codex-desktop-upgrade-diagnosis-playbook.md) | Renderer、Bridge、Agent 与 Model 的版本漂移排查。 |

## 固定快照的评审与验证

| 记录 | 证据范围 |
| --- | --- |
| [2026-09-22 Grok 空闲挂起](grok-idle-suspend-20260922.md) | Grok ACP 进程组在空闲 60 秒后释放，保留本地 Native Session。 |
| [2026-09-19 Cursor 空闲挂起](cursor-idle-suspend-20260919.md) | Cursor 接入统一资源合同、history-only 读取恢复、163 项定向测试与未执行的真实 CLI 验收。 |
| [2026-09-13 Cursor 委派策略与 xhigh](cursor-delegation-policy-20260913/README.md) | 公共策略修复、参数化目录、315 项定向测试及未通过的原生验收。 |
| [2026-09-12 全面评审](full-project-review-2026-09-12/README.md) | 改造前 29 项 finding 与 7 项架构建议的历史快照。 |
| [2026-09-12 整改结果](full-project-review-2026-09-12/remediation/README.md) | 本地修复、独立复审、测试日志与当时文件指纹；后续文档更新不修改该指纹。 |
| [DeepSeek 0.1.5-rc.1 验证](dsh-015rc1-validation.md) | 指定双版本、CLI 生命周期与协议证据，按文中基线解读。 |
| [Antigravity 提问复盘](antigravity-question-interaction-postmortem.md) | 原生问题交互的事故和验收记录。 |

## 设计提案与后续调查

以下内容以文内状态为准，不作为已交付功能清单。

| 文档 | 主题 |
| --- | --- |
| [Codex 原生账号切换设计](codex-native-account-switching-design.md) | 原生账号与凭据事务的候选设计。 |
| [Reasoning 预览与持久 Transcript](<Reasoning 实时预览与持久 Transcript 的后续方案.md>) | 后续展示与持久化方案。 |
| [回合文件变更汇总调查](<外部 Harness 回合文件变更汇总问题与后续方案.md>) | 净 Diff 与文件变化的调查及候选方案。 |

## 历史归档

| 文档 | 作用 |
| --- | --- |
| [Desktop 26.814 兼容性事故](archive/codex-desktop-incidents/26.814-compatibility-debt.md) | 旧版 Renderer、Bridge 与路由问题。 |
| [Desktop 26.908 Request Manager wrapper](archive/codex-desktop-incidents/26.908-request-manager-wrapper.md) | Fiber hook 结构变化的诊断记录。 |
| [DeepSeek 早期接入分析](archive/deepseek-integration/deepseek-harness-integration-analysis.md) | 接入前后的候选方案与实施分析。 |
| [Grok 早期 ACP 接入](archive/grok-integration/grok-cli-adapter-integration.md) / [Fork 分析](archive/grok-integration/grok-build-fork-integration.md) | 原生扩展与边界的早期调研。 |
| [Harness discovery 归档入口](archive/harness-discovery-pre-2df7058/README.md) | 公共发现包建立前的材料及失效结论。 |
