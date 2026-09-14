# Desktop 产品接入：当前仍需单独完成的范围

仅当交付包含 Desktop 可选、可创建/恢复 Thread、可展示配置与状态时读取本页。后端插件可明确不包含该范围；预装发行也不自动意味着 UI 接入完成。

## 现状与约束

Host 的插件目录与共享路由已经接入 Renderer：

- `packages/renderer-extension/src/renderer-model-client.ts` 提供按目标 Host 查询且校验结果的 `listHarnessPlugins()`。
- `agent-selection-state.ts` 使用 Harness ID 与 `externalConfigurationByAgent`；旧名单仅供旧 Host 兼容。
- `versioned-renderer-adapter.ts` 统一写共享 route；Picker、图标、偏好、ownership 与 Desktop Control 消费目标 Host 的目录和公共状态。

本页未带目录前缀的 Renderer 源文件均位于 `packages/renderer-extension/src/`。实施前重新核对上述源码；若某处已动态化，则验证通用路径，不重新加入固定分支。

**新增 UI 接线与公共层全面动态化是不同任务。**根据用户范围完成当前产品接入；发现必须扩大公共接口或 UI 状态模型才能正确支持时，明确缺口，不悄悄把新增插件扩展为全仓库迁移。

## 新插件的路由：一律使用共享编码

```text
选择目标 Host 上的 Harness 和配置
  → Renderer 写入共享插件 Transport Model carrier
  → Desktop thread/start
  → protocol-core 解码
  → 目标 Host 的 Adapter Map
```

读取 `packages/shared-contracts/src/harness-route.ts`、`packages/protocol-core/src/model-routing.ts` 和 Renderer 的 `versioned-renderer-adapter.ts`。

- 新 ID 使用 `encodeHarnessPluginRoute` / `decodeHarnessPluginRoute`；不要添加第八套 Harness 专用 prefix/codec。
- 旧七种编码属于历史兼容，保留既有读取行为；不可拿它们作为新插件模板，也不可借接入删除旧格式。
- Model Ref、Thinking、Permission Mode 遵守共享 schema 并完整往返；依赖字段约束以共享 codec 为准。
- 创建、配置更新、ThreadInspection 恢复必须一致。非法或缺失插件身份明确不可用，不回落到官方 Codex。

## 按职责检查当前接线

| 职责 | 当前源码入口 | 完成条件 |
|---|---|---|
| Agent 选择与配置草稿 | `agent-selection-state.ts` | 新 Agent 可选择；Model/Thinking/权限按 Agent 隔离；切换/重挂 Composer 不串状态 |
| 目标 Host、Catalog、ownership 和诊断 | `renderer-binding-probe.ts` | 目录、可用性、恢复身份和配置属于正确 Host/Thread；旧异步结果不能覆盖新目标 |
| carrier 写入与恢复 | `versioned-renderer-adapter.ts` | 新共享 codec 与 Host 兼容，创建和恢复配置一致 |
| Picker 与安装入口 | `renderer-agent-picker.ts`、`renderer-agent-icon.ts` | 名称、图标、安装链接和可用性一致；加载成功与原生 ready 区分 |
| Sidebar 与新 Thread 偏好 | `renderer-sidebar-agent-icons.ts`、`renderer-new-thread-preference.ts` | 旧 Thread 保留 Harness 身份，缺插件明确不可用，偏好不把未知值误恢复成 Codex |
| 权限偏好与展示 | `renderer-permission-mode-preference.ts`、`renderer-harness-localization.ts` | 只表达真实原生模式和作用域，不机械复制历史特例 |
| Settings | `settings/pages.ts` | Connections 状态、安装入口、刷新与错误提示一致 |

新增插件验证既有通用路径，不扩展 Renderer 固定名单、Host 注册表或专用 codec。只有公共合同无法表达的实际能力才评估共享扩展。

插件 Manifest 是新插件展示元数据来源。目录图标是经过校验的数据 URL，使用 img 展示，不把 SVG/描述字符串内联为 HTML。若当前静态 UI 仍需构建期资源，明确这是过渡产品接线，并保证与插件声明一致。

## 能力与运行状态

- Catalog/能力来自目标 Host 的 inspect，effective 状态来自原生确认后的 Thread 状态。
- selectModel、selectThinkingOption 和 selectPermissionMode 决定相应控件；权限 atCreate 不显示为任意 live 切换。
- Thread 配置通过公共 select 请求更新，失败时不把 requested 值当作已生效。
- 固定 Model 或空 Catalog 是合法原生情况；必须先写无 Model 的 Harness carrier 再允许提交，不能编造模型绕过。
- Usage 初始值、刷新、通知、Commands、压缩走既有公共路径，验证换 Thread/Host 后不残留前一个实例的数据。
- Credits 仍是 Host 结构检查加 UI 策略，不是 Manifest/Adapter 正式 capability；新增额度需求单独核对接口和使用方。
- Session Import 通过公共导入 UI 消费候选与 resolve 接口；只提供 list 的旧插件不能导入。Native Web UI 仍按实际能力接入并报告限制。

目录查询结果包含已加载的描述，也可能对应 unavailable Adapter；目录存在不代表原生安装、认证或运行就绪。旧 Host 不支持目录方法时显式显示兼容限制，不把错误伪装成空目录。

## 运行中调整方向

外部 Thread 的「调整方向」由实际 `session.steering` 与 `capabilities.turnControl` 决定：native interject 保留原生能力；restart 路径使用 `turn.cancel` → 等旧轮终态 → `turn.start`。插件验证[取消与后续 Turn](output-and-interactions.md#取消与后续-turn)的基础行为，不添加按 Harness 名称猜测的 Renderer 分支；官方 Codex Thread 保留原生 steer。workModes 只显示当前 Session 真实支持的模式。

对目标 Harness 验证新输入只展示、执行一次，成功后可继续跟进；失败时保留输入，既有队列和旧轮消息不会被错误恢复或重复发送。分别验证取消失败、超时和交付结果未确认，不能把客户端超时当作输入未被接受。共享实现、当前输入限制和版本化绑定见[外部 Thread 调整方向](../../../../docs/external-thread-steering.md)，不在插件中复制协调逻辑。

## Desktop Control 与发布

正式产品接入还检查：

- `packages/desktop-control/src/production-controller.ts`、`renderer-control-session.ts` 中的启用列表和注入参数。
- `tools/renderer-binding/run.mjs`、`renderer-observer.mjs` 和 `tools/codex-desktop-contract-audit/run.mjs` 中声称覆盖生产 Agent 的列表。
- `tests/release/production-renderer.test.mjs`、相关 Renderer/Desktop Control 测试及实际 Renderer build。

工具名单按实际用途维护，不要求所有诊断工具复制生产名单。Renderer 是浏览器包，不能引入 Node.js built-ins、Harness SDK 或 Electron 私有 API。

若修改共享 Desktop 方法绑定，按真实 `RpcTarget` 契约保留跨组件 RPC 可访问性：实例自身的函数属性不能替代可导出的类方法。覆盖安装、卸载和待定请求清理，并回归模型／权限列表读取及新会话提交就绪状态；普通对象的直接调用测试不能代替 RPC 验证。未修改共享绑定时复用已有回归，不为每个新 Harness 复制整套基础设施测试。

## 产品验收

1. 正确目标 Host 上能看到、选择并创建该 Harness 的 Thread，且 carrier 使用共享格式。
2. 未安装、认证失败、不可用、旧 Host 不兼容与刷新重试状态准确。
3. 新/旧 Thread 的 Model、Thinking、权限、ownership、Sidebar 和偏好一致。
4. Host/Thread 切换、Composer 重挂和异步响应乱序不会串配置或图标。
5. 受支持的工具、审批、提问、取消、[调整方向](#运行中调整方向)、Usage、Commands 和历史操作经真实 UI 验证。
6. 缺失插件不把原 Thread 交给 Codex；重新安装后的历史恢复按原生能力验证。
7. Desktop Control、生产 Renderer 构建和浏览器边界检查通过；截图只用于可见 UI 变化。

如果只完成后端，报告“插件后端可用，Desktop 未接入”，而不是把本页验证标成通过。若完成 UI 但未做真实原生验收，同样明确保留该验收项。
