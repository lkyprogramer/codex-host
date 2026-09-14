# Cursor 委派策略与 xhigh 接入修复

状态：源码修复与定向检查完成；指定模型的实机验收未通过。未安装、升级或替换当前 npm 包，未启动或替换当前 Desktop。

分支为 `codex/full-review-remediation-20260912`。代码基线与本次相关源码 SHA-256 见[源码清单](evidence/source-manifest.json)，临时插件 Bundle 见[构建收据](evidence/plugin-build-receipt.json)。本记录独立于 2026-09-12 的冻结评审，不改写旧验收收据。

## 修复内容

1. 公共委派输入与 CLI 增加 `--execution-policy default|unattended-full-access`。策略进入持久化和 Adapter open，非法值在副作用前拒绝。省略保持既有无人值守默认；显式无人值守与省略使用同一去重身份，兼容旧摘要；`default` 使用不同身份。官方 Codex 当前明确拒绝 `default` 覆盖。
2. Cursor create/resume 将无人值守意图映射为原生 `--force`。Agent 模式兼容该意图，Plan/Ask 不新增 force；带持久化策略的恢复在 open 前传入已保存模式，原生已确认的模式不重复配置。Host 不自动回答审批或问题。
3. ACP 协商 `parameterizedModelPicker`，读取 `cursor/list_available_models`，将有限的原生参数组合映射为已有 Model opaque ref。旧版本明确缺少该方法时保留原有变体目录。当前目录观察到 38 个基础模型、411 个组合；没有硬编码 xhigh、速度或默认参数。
4. 原生未报告完整当前参数时，只展示目录，不声明默认模型。明确选择模型后，在发布 Session 前逐项确认配置；已有相同 base model 不重复设置。任一部分配置失败都会关闭 Transport，并使已有 Session 发布 fault、结束 outputs。
5. 原生空目录只额外重查一次；持续为空仍失败，不使用旧目录冒充成功，不重放模型配置写入。保留 ACP 参数错误的具体说明，避免只显示 `Invalid params`。

## xhigh 的选择方式

指定原生 CLI 标识 `cursor-grok-4.6-xhigh` 对应本次目录中的：

```text
grok-4.6[effort=xhigh,fast=false]
Cursor Grok 4.6 (Effort: Extra High, Fast: Off)
```

通过当前候选 CLI 执行 `harness inspect cursor-cli`，使用返回的 opaque Model ref。不要把原生 CLI 标识直接当作 Host ref，也不要使用 `--thinking xhigh`；本适配器通过模型变体表达该参数。

## 验证结果

[检查汇总](evidence/validation.json)记录了实际执行范围：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint`（含边界检查） | 通过 |
| `git diff --check` | 通过 |
| Host CLI、控制服务、Coordinator、AppServerHost 定向测试 | 4 文件，226 项通过 |
| ExternalThreadRuntime 定向测试 | 1 文件，9 项通过 |
| Cursor Adapter 包测试 | 9 文件，80 项通过 |

这些是 315 个不同的定向测试，不是全仓测试或真实 Desktop 验收。覆盖策略传递、持久化、旧摘要与并发去重、恢复模式、原生参数目录、无默认状态、逐项读回、部分失败清理和旧 bracket 参数顺序兼容。

## 真实派发尝试

使用 Cursor CLI `2026.09.10-fd3934a`、临时插件 Bundle、仓库 CLI 包装器与独立 Host。官方 Codex 端是明确标记的 fixture，不执行推理；Cursor 端使用真实原生进程。验证任务要求仅在临时目录读取随机内容并写回文件，然后计划重启隔离 Host 验证同一 Thread 的恢复。

目标目录已经准确找到 xhigh / Fast Off，但派发没有成功：最终尝试在打开原生 Session 时得到 `Cursor returned no parameterized models`。此前尝试还出现 `Internal error` 与参数写入 `Invalid params`。原生分阶段诊断也观察到 `session/new` 已返回当前模型，之后目录查询却返回 0 项；不能据此把问题继续归因于原来的 Host 策略拒绝，但底层失败原因仍未确认。

- [最终候选尝试](evidence/receipt.json)：失败，清理无错误，未返回成功委派结果。
- [原生分阶段诊断](evidence/native-stage-diagnostic.json)：没有发送 prompt；记录目录为空与参数设置错误。
- 指定模型的任务执行、文件写回和 fresh Host resume **均未通过实机验收**。不重试配置写入、不替换为 High 模型，不把目录可发现当作执行成功。
- [npm 包核对](evidence/npm-package-integrity.json)：现有 `@codexhost/cli` 包内 3 个文件的前后指纹一致。

后续最佳检查是在同一原生版本与账号下，稳定复现 ACP 模型目录及参数设置失败并获取原生侧原因；恢复稳定后，再运行上述同一模型和文件写回场景。不能将本记录解释为已修复第三方原生服务问题。

## 保留边界

`default` 表示不新增 force 请求，不等于撤销历史授权。此版本 Cursor 的 `isRunEverything` 可随 Native Session 保留，ACP 没有对应撤销接口；切换 Plan/Ask 仍限制原生模式，但不保证清除历史 force。原生团队限制、显式 deny、问题和计划确认仍可能阻塞任务。

本次未做 Windows 实机验证。旧完整 bracket 载体支持参数顺序规范化；没有原生依据的 CLI 别名、缺失参数或未知参数不会被猜测补齐。其他原生版本及历史载体仍需分别验证。
