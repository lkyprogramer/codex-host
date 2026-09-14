# Harness 常驻进程排查（2026-09-13）

## 已观察事实

- 排查分支：`codex/full-review-remediation-20260912`，延续本分支已有未提交改造。
- 当前安装的 npm CLI / macOS 平台包版本为 `0.7.0-local.2`。
- 截图对应的 14 个 OpenCode Server 均由仍存活的安装版 Host（PID 2457）持有，命令为 `opencode serve --hostname=127.0.0.1 --port=0`；进程已存活约 2–12 小时。
- PID：3863、3864、3865、4511、9408、11018、13782、13792、13802、13825、21938、32267、35293、74845。
- 它们不是父进程已退出的孤儿。截图活动监视器内存与 `ps` RSS 是不同指标，本报告不混用或据此推算释放量。
- 候选源码同样每个 OpenCode Session 创建独立 Server，Turn 完成后仅将 Thread 置为空闲；修复前没有自动回收路径。

未安装或替换 npm 包，未重启当前 Desktop，未终止上述既有 OpenCode 进程。

## 确认的问题

| 问题 | 影响 |
| --- | --- |
| Host 将 Thread 生命周期与原生 Session 常驻绑定 | 已完成任务累积常驻 Server / CLI，多个 Harness 都可能受影响 |
| OpenCode 没有有效的显式资源释放路径 | 旧 `thread release` 只识别 Grok owned-job 接口，返回 unsupported |
| OpenCode Adapter.close 未协调正在 open / inspect 的资源 | 关闭返回后仍可能发布新 Session 或留下进程 |
| OpenCode SSE pump 的关闭没有界限，清理顺序依赖 transport.close 成功 | SSE 卡住或失败可跳过 Server 关闭 |
| 多个 Adapter 只观察 leader 退出 | 子孙进程可能仍占资源，关闭被误报成功 |
| 父 Turn 终态不代表后台工作全部静默 | 统一强杀会中断子任务，必须通过原生合同判断 |

## 统一修复

1. 公共 `HarnessSession.resourceLifecycle.suspend` 描述原子挂起，而非 Host 分两步查询 / 强制 close。Host 的 `ManagedHarnessSession` 统一协调操作、挂起、恢复和输出代次；空闲阈值为 60 秒，未知状态退避重试，最大间隔 5 分钟。
2. 挂起保留 Thread，完整读取、发送及配置按需恢复。恢复身份与能力在写入快照 / 映射之前校验；状态轮询不唤醒。旧输出必须结束，违约插件不能带着未停止的旧代继续启动新代。
3. `harness-discovery.trackOwnedProcessTree` 在 spawn 时登记所有权，leader 退出即开始同一清理流程；TERM / KILL 后验证全组退出。macOS 退出期间的 EPERM 存在性探测被视作仍存活，实际信号失败明确拒绝。丢失所有权后保留失败，不用旧 PID 做迟到重试。
4. OpenCode 的 open / inspect 与 close 并发、SSE 关闭阻塞、健康检查超时、清理顺序及失败所有权丢失分别修复。Claude Code、Kiro 同样保留清理失败的资源记录。
5. `thread release` 增加 `resourcesReleased`，不将原生资源挂起冒充 owned-job 静默；发行 help / Skill v10 和接入文档同步说明。

## 各 Harness 当前边界

| Harness | 自动空闲挂起 | 进程关闭与剩余限制 |
| --- | --- | --- |
| OpenCode | 接入统一合同 | 全部 native status + Session 身份 + Question / Permission 检查；复用公共进程树清理 |
| Claude Code | 接入统一合同 | 活动 / 接受 / 配置 / 历史 / 启动 / 取消 / Usage / 后台占用保护；沿用 SDK / Broker 原生关闭及已有进程组证明 |
| Kiro | 接入统一合同 | 活动 / 交互 / 配置 / 读取 / Usage 保护；未持久化空 Session 拒绝挂起；ACP 复用公共进程树清理 |
| Cursor | 不自动启用 | 公共进程树清理已接入；父任务结束后后台任务投影不足以证明实际静默 |
| CodeBuddy | 不自动启用 | 公共进程树清理已接入；本地将后台任务标记 interrupted 不代表原生任务已停止 |
| OMP | 不自动启用 | 公共进程树清理已接入；旧原生版本可能不提供后台订阅，自主 / 后台任务需补齐原生静默合同 |
| Pi | 不自动启用 | 公共进程树清理已接入；支持自主 Turn，但没有完整后台任务清单 |
| DeepSeek Harness | 不自动启用 | Modern managed Web 接入公共清理并等待异步全组结果；共享与独立 Web 所有权、自主任务和队列状态需要单独完成静默合同 |
| Grok | 不自动启用 | 保留原有显式 owned-job 释放；它会停止任务，不等价于无副作用的 idle 挂起；原生 close 后恢复与后台静默仍需证明 |
| Antigravity | 空闲时无常驻 Turn 主进程 | POSIX Turn 使用独立受管进程组，关闭 / 取消 / 终态清理接入公共工具；不接管外部共享 Language Server；Windows 自行退出的 Turn 尚无独立 Job Object，保持原有主进程关闭路径 |

统一的是 Host 生命周期与资源所有权机制，并非强制所有原生工具具有相同能力。尚未启用自动挂起的 Harness 仍可能保留常驻进程；本次不能宣称十种 Harness 均已自动释放内存。

## 验证

真实 OpenCode `1.18.30` / SDK `1.18.25` 在隔离 HOME / XDG / cwd 中完成两次资源挂起，PID 83715、83766 的进程组均消失，恢复保持同一 Native Session ID，测试遗留组为零。此次创建的是空 Session，没有模型 Turn、工具执行或付费调用，不能替代真实任务完成后的全链路验收。[机器可读结果](harness-resource-evidence-20260913/opencode-native-smoke.json)。

首次真实 smoke 揭示退出期间 EPERM 从轮询定时器逃逸的问题；公共清理工具修复后重跑通过。这说明仅检查 mock close 调用不足以证明回收正确。

随后将同一真实 Adapter 放入统一 `ManagedHarnessSession`，验证挂起后通过完整读取惰性恢复：PID 91906、91908 两轮进程组均退出，Native ID 保持一致，代理 fault 与测试残留均为零。[统一代理组合验证结果](harness-resource-evidence-20260913/opencode-managed-smoke.json)。该 smoke 显式触发挂起；60 秒定时与 Host 调度竞态由定向测试覆盖。

输出缓冲与延迟 identity 修复完成后再次运行同一组合验证，PID 880、885 均退出，结果仍为同一原生身份、零 fault、零遗留组。[最终组合 smoke](harness-resource-evidence-20260913/opencode-managed-final-smoke.json)。

最终验证：

- **830 / 830 定向用例通过，24 个测试文件，0 skipped。** 首轮 815 项中 804 通过，11 个 Kiro 内存 ACP 用例因没有模拟新增的 owned-tree 契约失败。修正测试载体且保留生产 fail-closed 后，仅重跑 Kiro 三个相关文件（89 / 89，包括新增 inspection 回归）。按测试文件取最后结果合并，不重复累计测试数。[文件清单与结果](harness-resource-evidence-20260913/focused-validation.json)。
- 命令入口为 `node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js <上述记录的测试文件>`；覆盖公共 Session 校验、进程树、全部修改的 Adapter 路径、Host 生命周期 / 委派 / app-server、CLI help 与 Skill。
- `npm run typecheck`、`npm run lint` 通过；检查了生产、测试类型与包边界。
- `npm run build:plugins` 通过，十个预装插件的本地 Bundle 已按最新源码重建；没有写入全局 npm 安装目录。
- `git diff --check` 通过；修改的 TypeScript 文件经过 Prettier，相关文档本地链接检查无错误。
- `node packages/host-runtime/dist/main.js --codexhost-delegation-cli thread release --help` 实际输出新增资源语义。
- `python3 /Users/luo/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/codexhost-add-harness` 通过。

验证使用 Node `22.22.0`，不通过 npm 安装依赖或替换全局包。完整 Rust、浏览器和未受影响测试未运行。

[候选源码清单与 SHA-256](harness-resource-evidence-20260913/candidate-source-manifest.json) 绑定当前分支的相关修改文件，包含本分支此前的评审改造，不代表已创建独立提交。

## 当前安装版

本次只修改源码及本地构建产物。安装版进程没有热替换，因此截图中的既有常驻进程不会因本分支修复而自动减少。后续发布 / 安装 / 重启需另行执行；本次未执行这些操作。

Windows taskkill 路径经过实现检查，本次未在真实 Windows 运行。root 退出后不能仅凭旧 PID 证明或安全回收整棵树；Antigravity 的 Windows 后代回收仍需独立 Job Object 接入，不能称为已修复。除上述 OpenCode 空会话 smoke 和本地进程 fixture 外，未执行各 Harness 的真实模型任务、远端 / 容器后台任务或完整 Desktop 验收。
