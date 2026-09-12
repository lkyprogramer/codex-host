# Grok Plan 与运行中 Steer

Grok 的 Plan 是 ACP Session Mode，不是 Permission Mode。Ask / Auto / Always approve 仍只控制工具权限。Steer 使用原生 `_x.ai/interject`，不取消当前回合后再发一条普通 prompt。

## Plan

Desktop 现有 Plan 入口会把 `collaborationMode.mode` 放进 `turn/start`。Host 把它映射为公共工作模式 `default | plan`，不转发 Codex 专用系统提示。

- Grok 始终暴露 `session.workMode`。原生模式 id 为 `default` 与 `plan`；`session/new` 通常不带 ACP `modes`，不以该字段作为能力广告。
- 显式选择优先。请求 `plan` 时，Host 在发送 prompt 前调用 `session/set_mode`；失败则不启动回合。方法不存在时为 `unsupported`。
- 恢复会话且请求未带选择时，读取原生 `currentModeId` 或历史 `current_mode_update`，不用 Host 默认值覆盖。原生当前模式未知时，显式 Desktop `default`/`plan` 都会调用 `session/set_mode`。
- 原生 `current_mode_update` 是已生效状态的真源。
- 未声明模式的插件保持原接口。用户在这些插件上选择 Plan 时，Host 返回明确的不可用错误，不会静默改成普通模式发送。

本批不增加 `/plan` 命令；普通文本中的 “plan” 仍是文本。

## Steer

`turn/steer` 仍按 Thread 归属分流，外部请求不会落到官方 Codex。

- Grok Session 提供可选 `steering.interject`。Host 校验 `expectedTurnId` 等于当前活动回合后调用 `_x.ai/interject`。
- 返回 `{ turnId }` 仍是当前回合。`queued` 只表示原生已接收，不表示模型已处理。超时不自动重发。
- 无活动回合或目标已过期时失败；不新开回合，不回落官方 Codex。
- 原生扩展不存在时返回明确不支持错误，不改用 cancel 后 `turn.start`，也不使用 `sendNow`。
- 未实现 `steering` 的其他 Harness 继续使用现有 cancel → 等待终态 → start 替换路径。

Renderer 在所有权结果带 `nativeSteering: true` 时走 Desktop 原有 `steerTurn` 展示，把插话放在当前回合；失败由 Desktop 保留输入。
