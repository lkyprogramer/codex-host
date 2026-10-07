# codexhost fork：上游 v0.10.1 之后可借鉴的改造（按修复顺序）

2026-10-07 · fork `main` `7428886d`（另有本地分支 `fix/session-kernel-review`） · 上游 `origin/main` `d2ee6150`（v0.12.2 之后 7 个提交）

**结论：** 优先借鉴两项协议层修复和一组 Desktop 新版本兼容。本机 Desktop 为 ChatGPT.app 26.930，比上游适配过的 26.924 / 26.928 都新。其次是 4 个已有 Harness 的小缺陷，fork 中已确认存在同样问题。新 Harness、远程 SSH 管理和恢复控制台排在后面。fork 自己的底层架构上游没有等价物，必须保留，不整树同步：process anchor、插件 API v2、SessionKernel、`acp-core`、`pi-family`、`thread observe`。

本文是修复队列，不是已实施的结果；实施进度见第 8 节。按第 3 节的顺序逐卡执行，每张卡验收通过后再进入下一张。

## 1. 范围与基线

- **上一轮对比**：[upstream-comparison-20260926](../upstream-comparison-20260926/README.md)，基线为上游 `997f62a0`（v0.10.1），共 35 个候选。R1–R5 与 U28 已实施并合入 `main`：U01–U10、U12–U20、U22–U25、U28、U30–U32。
- **上一轮遗留**：
  - 未做：U26 Pi 子代理工作流、U27 DSH 新协议、U29 CodeBuddy fork/修订、U34、U35、U37、U39 新 Harness。
  - 条件暂缓：U33。
- **按用户要求排除，本轮继续排除**：账号、额度展示与刷新、其他 Harness 的会话导入、Pi 凭据导入。U11（额度门控）已由用户重新纳入，改为卡片 V00，放在迭代 D。
- **本轮评估范围**：上游 `997f62a0..d2ee6150` 共 209 个提交（190 个非 merge），813 个文件，+73.7k/−10.1k 行。release 说明为 v0.10.2、v0.11.0、v0.12.0、v0.12.1、v0.12.2（预发布）。
- **本机环境**：
  - ChatGPT.app 26.930.61225；
  - OpenCode 1.18.30（v1 协议）；
  - cursor-agent 2026.09.10；
  - grok 1.0.50；
  - 未注册任何 codexhost LaunchAgent（broker 未常驻）。
- **上游代码位置**：本地 worktree `../codex-host-upstream`（detached，`origin/main`）。

### 证据等级

- **已核实**：在 fork 源码中定位到同样的缺陷，给出位置。
- **推断**：fork 缺少上游对应的实现，但未复现现象。
- **待确认**：需要先在 26.930 上观察现象，再决定是否实施。

本轮只做了代码阅读、grep 对照和 release 说明分析。没有运行 Desktop，也没有用真实 Harness 复现。

## 2. 总表

| 顺序 | ID | 改造 | 等级 | 规模 | 风险 |
| --- | --- | --- | --- | --- | --- |
| 1 | V01 | 官方请求必有回复（reply guard） | 已核实 | S–M | 中 |
| 2 | V02 | 官方流量先判归属，未识别请求原样转发 | 已核实 | M | 高 |
| 3 | V03 | OpenCode v1 每个受管 Server 独立端口 | 已核实 | S | 低 |
| 4 | V04 | Claude transcript 按 uuid 去重 | 已核实 | S | 低 |
| 5 | V05 | Claude 认证失败只按原生错误码判断 | 已核实 | S | 低 |
| 6 | V06 | Host 运行日志写入有界文件 | 已核实缺失 | S–M | 低 |
| 7 | V07 | 预热 Session 的释放与历史隔离 | 已核实缺失 | M | 中 |
| 8 | V08 | Desktop Fork 识别修复 | 已核实 | S | 中 |
| 9 | V09 | React fiber 遍历上限与 Renderer 开销 | 已核实 | M | 中 |
| 10 | V00 | Codex 额度耗尽时外部 Harness 仍能发送 | 已核实缺失 | M | 高 |
| 11 | V10 | Project 内创建 External 任务 | 推断 | M | 中 |
| 12 | V11 | 导航栏入口 | 待确认 | M | 中 |
| 13 | V12 | Renderer CDP 卡住不阻塞启动 | 推断 | S–M | 中 |
| 14 | V13 | 外部 `/compact` 后恢复排队消息 | 推断 | M | 中 |
| 15 | V14 | Antigravity 结果按对话校验，拒绝类不重试 | 待确认 | S | 低 |
| 16 | V15 | Cursor 回答分段边界 | 待确认 | S | 低 |
| 17 | V16 | Claude root 声明沙箱时允许绕过权限 | 推断 | S | 中 |
| 18 | V17 | Claude 后台命令显示为 Desktop 后台终端 | 新能力 | M | 中 |
| 19 | V18 | 完成后折叠执行过程（最终回复阶段） | 新能力 | M | 中 |
| 20 | V19 | 历史原生任务的引用与 @ 搜索 | 新能力 | M | 中 |
| 21 | V20 | External Thread 进入 Desktop 分区、置顶与排序 | 新能力 | M–L | 高 |
| 22 | V21 | OpenCode v2 协议 | 条件 | L | 高 |
| 23 | V22 | 恢复控制台、Harness CLI 安装与更新 | 条件 | L | 中 |
| 24 | V23 | 远程 SSH 管理、会话同步、多 Host 隔离 | 条件 | L | 高 |
| 25 | V24 | Aqua broker 按需启动与空闲退出 | 条件 | M | 中 |
| 26 | V25 | 上一轮遗留：U26 / U27 / U29 | 条件 | L | 高 |
| 27 | V26 | 新 Harness（ZCode / Hermes / Kimi / WorkBuddy / Qoder） | 最后 | L / 每个 | 高 |

规模和风险的口径与上一轮相同：S 是局部函数加定向测试；M 涉及几条调用路径；L 跨公共合同或多层状态。风险指移植风险，不是工期承诺。

## 3. 推荐迭代

| 迭代 | 卡片 | 目标 | 完成门槛 |
| --- | --- | --- | --- |
| A · 协议可靠性 | V01 → V02 | Desktop 不会因 Host 意外失败或新协议字段而永久等待或被拒 | 每类请求都有回复，或原样转给官方；codexhost 自有请求的错误仍按严格校验返回 |
| B · 已有 Harness 小修 | V03、V04、V05、V06 | 四个独立小补丁 | 定向测试加反向验证；OpenCode 两个 v1 Session 先后打开不串连接 |
| C · 资源与历史 | V07 | 预热不泄漏原生进程，不污染历史 | 放弃的预热关闭 Session 并移除映射；已接管的不被误关 |
| D · Desktop 兼容 | V08 → V09 → V00 → V10 → V11 → V12 | 26.930 上 Fork、模型加载、额度耗尽时外部发送、Project、入口、启动正常 | 每项先在 26.930 观察现象；fixture 加实际渲染 |
| E · 体验修复 | V13、V14、V15、V16 | 逐项小修 | 各自定向测试 |
| F · 新能力 | V17 → V18 → V19 → V20 | 按使用频率选择 | 实时与历史回放一致；mapping-store 迁移可回滚 |
| 以后 | V21–V26 | 有明确需求时立项 | 原生版本固定、create/resume/fork/cancel/cleanup 均有收据 |

迭代 A、B 之间没有依赖，可以并行；D 中各卡共享 renderer 的 binding 文件，同一时间只交给一个 owner。

## 4. 任务卡

每张卡执行前的第一步：重新核对当前 HEAD 与卡片前提。若目标已实现，关闭该卡，不重复搬运。

---

### V01 · 官方请求必有回复

- **来源**：上游 `893fd07e`、`8d35e131` 中的 reply guard；文档 `docs/architecture/official-traffic-ownership.md` 的“请求必有回应”一节（上游 worktree 内）。
- **fork 现状（已核实）**：
  - `packages/host-runtime/src/app-server-host.ts` 的 `#dispatchDesktopRequest(run)` 只做 `void run().catch((error) => this.#diagnose(error))`。后台任务失败时，Desktop 收不到回复。
  - fork 没有按请求 ID 记录“是否已回复 / 已转发”的保护。上游为 `#replyGuards: Map<id, Set<{ answered }>>`，未回复时返回 `-32603 "codexhost could not handle the request"`。
- **改动**：
  1. 在 Desktop 请求入口为每个请求建立 guard；写出响应或转发官方时标记为已回复。
  2. 同步处理抛错，以及 `#dispatchDesktopRequest` 派生的后台任务失败时，若 guard 未回复，返回 `-32603`。
  3. 已回复或已转发的请求不重复回复。
- **验收**：
  - 测试覆盖同步抛错、后台任务 reject、已回复后又抛错（不得重复回复）、已转发后抛错四种情况。
  - 诊断日志仍记录原始错误。
- **风险**：重复回复会让 Desktop 侧出现未知 ID 的响应；标记点必须覆盖所有写响应的路径，包括 `#writer.json` 和转发路径。

### V02 · 官方流量先判归属，未识别请求原样转发

- **来源**：上游 `8d35e131`（#480/#481）。原则是“默认放行、显式截获”：只处理确认属于 codexhost 的请求，其余原样转给官方 app-server，由官方自己校验。
- **fork 现状（已核实）**：
  - `packages/protocol-core/src/model-routing.ts:556`：`decodeCreateRoute` 在 `thread/start` 的 `params.model` 不是文本时直接抛错 `"thread/start params.model must be text"`。上游提到 MCP App 打开的原生 Thread 不带 Model，这类请求在 fork 中会被拒绝。
  - `app-server-host.ts` 中 `thread/list`、`thread/archive|unarchive`、`thread/metadata/update` 等分支都是先 decode、失败即返回 `-32602`，然后才 `#locateExternalThread`。
- **归属判别**（只读以下字段，识别本身不抛错，读不到即视为官方请求）：
  - `method` 以 `codexhost/` 开头；
  - `thread/start.params.model` 是带 `codexhost/` 前缀的文本运输标记；非文本或缺失的 Model 属于官方；
  - `params.threadId` 指向 Mapping Store 中的外部 Thread；
  - `thread/list` 的 cursor 是 Host 的游标（上游 `carriesHostThreadListCursor`）。
- **改动**：
  1. 新增不抛错的 `routingParams(request)`，先判归属。
  2. 只有 Host 拥有的请求才走严格 decode；格式错误的 codexhost 标记和游标仍返回 `-32602`。
  3. 其余请求调用 `#forwardOfficialRequest` 原样转发。
  4. 在 fork 文档中补一节“官方流量归属”。
- **验收**：
  - 不带 `model` 的 `thread/start` 被转发而不是报错；
  - 外部 Thread 上格式错误的 archive/metadata 请求仍返回 `-32602`；
  - 未知 method 原样转发；
  - 官方 Thread 上带未知参数的 turn/thread 请求原样转发。
- **依赖**：先做 V01。
- **风险**：判别过宽会把外部 Thread 的请求漏给官方，判别过窄会继续误拒。用外部 Thread、官方 Thread、无 threadId 三组 fixture 逐个方法覆盖。

### V03 · OpenCode v1 每个受管 Server 独立端口

- **来源**：上游 `a4258502`（#435）。
- **fork 现状（已核实）**：`packages/adapters/opencode/src/command.ts:71` 以 `serve --hostname=127.0.0.1 --port=0` 启动。opencode v1 把 `--port=0` 当成默认端口 4096，所有 Session 共用同一个地址。Node 全局 fetch 连接池按地址复用 keep-alive 连接，前一个 Server 退出后，下一个 Session 的请求可能落到失效的连接上。本机 OpenCode 1.18.30 是 v1，一定会遇到。
- **改动**：
  - 由 Host 预先选一个空闲的回环端口传给 v1；
  - 或者在 `server-connection.ts` 中为每个 Server 使用独立的 dispatcher/agent，不共用全局连接池。

  先读上游 `server-connection.ts` 的具体做法；注意“选端口”和“绑定端口”之间存在竞态，要有失败重试或改为由 Server 报告实际端口。
- **验收**：
  - 两个 Session 先后打开、关闭、再打开，请求都落到当前 Server；
  - 端口被占用时有明确错误或重试；
  - 原有 OpenCode 测试全部通过。
- **风险**：v2 行为不同，要按版本分支处理（与 V21 协调）。

### V04 · Claude transcript 按 uuid 去重

- **来源**：上游 `ed19722a`。
- **fork 现状（已核实）**：`packages/adapters/claude-code/src/claude-transcript.ts:84` 对每条记录直接 `messages.push`。原生会改写同一 uuid 的记录，历史读取会出现重复消息。
- **改动**：与原生 SDK 一致，同一 uuid 取最后一条记录（含元数据），保留首次出现的顺序：`Map<uuid, record>` 后取 `values()`。
- **验收**：同一 uuid 出现两次时，结果只有一条，内容取后者，位置取前者；无 uuid 的记录行为不变（先核对现有代码如何处理无 uuid 的条目）。

### V05 · Claude 认证失败只按原生错误码判断

- **来源**：上游 `2784f643`（#403）。
- **fork 现状（已核实）**：`packages/adapters/claude-code/src/native-message.ts:136-138` 除错误码外还按文本匹配 `"not logged in"`、`"invalid api key"`、`"oauth"`。成功回复正文里只要提到这些词，就会被判为认证失败。
- **改动**：`includesAuthenticationFailure` 只检查 `AUTHENTICATION_ERRORS` 中的原生错误码（`authentication_failed`、`oauth_org_not_allowed`）。
- **验收**：正文含 “OAuth” 的成功回复不再判为认证失败；带原生认证错误码的结果仍判为认证失败。

### V06 · Host 运行日志写入有界文件

- **来源**：上游 `49fbe920`（#404），新增 `packages/host-runtime/src/runtime-log.ts`，并接入 `main.ts` 与 `release-main.ts`。
- **fork 现状（已核实缺失）**：没有 `runtime-log.ts`；stderr 诊断与致命堆栈不落盘。此前排查“模型和 Harness 列表加载不了”时，缺的正是这类证据。
- **改动**：
  - 把 stderr 诊断和未捕获异常的堆栈写入大小有上限的日志文件（滚动或截断），位置放在用户数据目录下；
  - 不写入 token、凭据或完整的进程命令行。
- **验收**：
  - 超过上限后文件大小受控；
  - 致命错误时堆栈落盘；
  - 日志目录不可写时 Host 照常启动；
  - 日志中不出现环境变量里的密钥（加测试断言）。

### V07 · 预热 Session 的释放与历史隔离

- **来源**：上游 `bac41c30`（新增 `external-thread-prewarms.ts`）、`6897e530`、`aeae5642`（#482）；文档为上游 `docs/architecture/harness-plugin-runtime.md` 的“外部 Thread 预热”一节。
- **fork 现状（已核实缺失）**：`packages/desktop-control/src/renderer-draft-prewarm-runtime.ts` 会预热外部草稿，但 Host 没有 `codexhost/thread/prewarm/discard`，也没有预热状态。
- **影响**：被放弃的预热 Session 带着原生进程，只能等空闲释放回收；未发送过消息的预热 Thread 可能出现在会话历史里。
- **改动**：
  1. Desktop Control 只给外部、非 ephemeral 的预热 `thread/start` 加 `codexhostPrewarm: true`。
  2. Host 在每 Thread 请求队列内裁决：
     - Turn、原生命令、配置选择、恢复等操作会接管预热；接管后迟到的 discard 返回 `discarded: false`；
     - 未接管、无活动工作、无历史的预热：先关闭 Session、等待输出结束，再移除映射；
     - 关闭失败时保留映射，并阻止继续使用。
  3. 未提交的预热 Thread 不进入 `thread/list` 和历史。
- **验收**：
  - 放弃、迟到放弃、已接管后放弃、重复放弃、关闭失败五种情况；
  - 普通空 Thread 不能被 discard 删除。
- **注意**：上游的“写入预留隔离”部分属于 broker（`nativeWriterRef`）。fork 的 Claude pending 预留已在 `a2b09a0c` 改为持有者 token，不需要再搬这部分。

### V08 · Desktop Fork 识别修复

- **来源**：上游 `8b865440`（Copy 按钮不再被当成 Fork）、`8636ee36`（支持更深的 Fork 所属层级）。
- **fork 现状（已核实）**：`packages/renderer-extension/src/renderer-fork-control.ts` 只要发现 `props.onFork` 就认定为 Fork，没有区分 Copy 按钮先经过自己的 `onCopy` 回调这一情况。所属层级的查找深度也是旧值。
- **改动**：按上游实现，区分 Copy 和 Fork 共用的 action-bar 与按钮原语；扩展所属层级的查找深度。
- **验收**：
  - fixture 覆盖 Copy 与 Fork 两种按钮；
  - 在 26.930 上实际点击 Copy 不触发 Fork，点击 Fork 能识别外部 Thread。

### V09 · React fiber 遍历上限与 Renderer 开销

- **来源**：上游 `c7f38ffc`（#443）、`76c389ef`、`b3b7a8bd`（#447）。
- **fork 现状（已核实）**：`packages/desktop-control/src/renderer-react-ownership.ts:10` 上限为 20000，达到后静默截断。上游提高了上限（`MAX_VISITED_FIBERS`），并在耗尽时派发 `codexhost:react-fiber-walk-limit` 事件上报。
- **影响**：侧边栏较大时，Composer 一直显示 “Loading models…”。
- **改动**：
  1. 提高上限，耗尽时上报，不再静默；
  2. 移植减少输入协调开销、减少重复扫描和已提交 Fiber 遍历的改动（`renderer-binding-probe.ts`、`renderer-composer-dom.ts`、`renderer-sidebar-agent-icons.ts`）。
- **验收**：
  - 大侧边栏 fixture 下模型列表能加载；
  - 耗尽时有诊断事件；
  - 输入时不触发全量扫描（可以用调用计数断言）。

### V10 · Project 内创建 External 任务

- **来源**：上游 `d03c40a7`（#430），涉及 `mapping-store`（`mapping-store.ts`、`records.ts`）与 `app-server-host.ts`。
- **fork 现状（推断）**：26.924 起，在 Project 内创建任务会对 External Thread 发出 metadata 更新，fork 的 Mapping Store 不接受这些字段。
- **改动**：先在 26.930 上复现“在 Project 内创建 External 任务”失败；确认后再按上游接受 External Thread 的元数据更新并持久化。
- **验收**：Project 内创建、重启后仍在 Project 内；Mapping Store 旧记录可读，新字段可回滚。
- **风险**：涉及持久化格式，要评估前后版本混用时的兼容性。

### V11 · 导航栏入口

- **来源**：上游 `104a9bfe`（`settings/trigger.ts` 重写，`settings/icons.ts`）。
- **fork 现状（待确认）**：fork 没有导航栏入口；设置入口仍是旧的按钮注入方式。
- **改动**：先在 26.930 上确认现有入口是否还能出现、位置是否正确；只有失效或冲突时才迁移到导航栏。
- **验收**：26.930 实际渲染截图；旧版本 Desktop 仍可用（如需要）。

### V12 · Renderer CDP 卡住不阻塞启动

- **来源**：上游 `f0570198`、`48543476`（#333，中间曾回退后重新合入）。
- **fork 现状（推断）**：`desktop-control` 中 Controller 就绪要等 Renderer CDP；调试端点卡住时启动会被阻塞。
- **改动**：Renderer CDP 连接设上限，超时后 Controller 先就绪，Renderer 侧在后台重试。
- **验收**：模拟 CDP 端点挂起，Desktop 仍能启动，Renderer 恢复后能注入。

### V13 · 外部 `/compact` 后恢复排队消息

- **来源**：上游 `7c960f12`（#423），新增 `renderer-manual-compaction.ts`，并修改 `external-command-routing.ts`。
- **fork 现状（推断）**：fork 没有把外部的显式 `/compact` 桥接到 Desktop 原生的手动压缩登记，压缩后排队的后续消息可能不再发送。
- **改动**：只把外部显式 `/compact` 事件登记为手动压缩；其他命令中的自动压缩不算手动压缩。
- **验收**：外部 Harness 执行 `/compact` 后，排队的消息自动发送；自动压缩不触发登记。

### V14 · Antigravity 结果按对话校验，拒绝类不重试

- **来源**：上游 `014f1673`（#458）。
- **fork 现状（待确认）**：`antigravity-adapter.ts:928` 已经对事件校验 `conversation_id`，需要确认结果、用量、checkpoint 和历史投影的路径是否也有校验。地区限制和个人额度类拒绝目前是否可重试，也需要核对。
- **改动**：投影结果前校验 `conversation_id`，不一致时报不可重试的 `protocolError`；地区和额度拒绝标为不可重试，保留原始文本。

### V15 · Cursor 回答分段边界

- **来源**：上游 `540a2782`（同时修改 WorkBuddy、Kimi 与 Cursor；fork 只涉及 Cursor）。
- **改动**：先读上游 Cursor 部分的 diff，确认 fork 是否把多段回答合并成一段；确认存在后再移植。

### V16 · Claude root 声明沙箱时允许绕过权限

- **来源**：上游 `1d3d6db1`（#425）。
- **fork 现状（推断）**：`sdk-transport.ts:145-147` 只要以 root 运行就不传 `allowDangerouslySkipPermissions`，比 CLI 原生规则更严。CLI 的规则是：只有 root 并且没有声明沙箱（`IS_SANDBOX` 不为 `1`、`CLAUDE_CODE_BUBBLEWRAP` 不为真）时才禁止。
- **改动**：按 CLI 原生规则、用实际传给 CLI 的环境判断；不可用时从权限模式列表移除 `bypassPermissions`，权限切换被拒绝时显示失败。
- **说明**：只有以 root 运行时才相关，本机不一定涉及，可以按需推迟。

### V17 · Claude 后台命令显示为 Desktop 后台终端

- **来源**：上游 `46e3ae54`（#408），新增 `background-command-items.ts`。
- **fork 现状**：fork 已经通过 `hasBackgroundTasks` 阻止有后台任务时的空闲释放；本卡只是把后台命令展示为 Desktop 后台终端，可查看实时输出、停止全部。
- **验收**：实时和历史回放一致；停止操作只作用于本 Session 的后台任务。

### V18 · 完成后折叠执行过程

- **来源**：上游 `b1201ce4`（#411），新增 `protocol-core/src/final-answer-phase.ts`，并修改 `codex-ui-projector.ts`。
- **改动**：为成功的 Turn 推断最终回复阶段，使 Desktop 可以把执行过程折叠到最终回复之后；符合条件的历史对话同样生效。

### V19 · 历史原生任务的引用与 @ 搜索

- **来源**：上游 `0e8d1a91`（#428），新增 `native-thread-reference-capability.ts` 与 `renderer-thread-reference-capability.ts`。
- **改动**：在符合条件的原生 Codex 历史任务中，恢复拖拽引用和 @ 任务搜索。

### V20 · External Thread 进入 Desktop 分区、置顶与排序

- **来源**：上游 `e52feca9`（#445，新增 `external-thread-sections.ts`）、`fce2ec41`（#446）、`733a12ec`。
- **改动**：External Thread 可加入 Desktop 的分区并置顶、排序；恢复、取消归档、回退或相邻 Thread 被移除后保持位置。
- **风险**：修改 mapping-store 持久化；需要迁移和回滚方案。与 V10 共享存储改动，放在 V10 之后。

### V21 · OpenCode v2 协议

- **来源**：上游 `317c073a`、`1d3b6c27`、`a4258502` 的 v2 部分。
- **触发条件**：本机升级到 OpenCode v2 之前。
- **要点**：保留 v1；已有 Session 需要对应主版本的 CLI；v2 的内容身份冲突与卡住的 Turn 一并处理。需要与 SessionKernel 的 OpenCode 实现对齐。

### V22 · 恢复控制台、Harness CLI 安装与更新

- **来源**：上游 `636b5013`（#432，新包 `console-server`）、`b414a0dd`、`1a0bb80e`（#449）、`034d5be3`（#454）、`5caee11e`（#459）。
- **建议**：先做 V06 的运行日志；控制台只有在 Desktop 启动失败成为常见问题时才立项。

### V23 · 远程 SSH 管理、会话同步、多 Host 隔离

- **来源**：上游 #473（`ad944440`、`89263145`、`081e9ba5`）、`4a004fad`、`3c2d1cb5`、`f112b283` / `92024e4d`（#466）、`40ee7164`（#490）、`ad1e8450`（#418）、`2e352eec`（#420）、`d2ee6150`（远程图片附件）。
- **触发条件**：经常使用 SSH 远程或多 Host 时。其中 #418 / #420（远端官方 Codex 退出后恢复、listener 替换旧 socket）可以先单独移植。

### V24 · Aqua broker 按需启动与空闲退出

- **来源**：上游 `998a8426`（#483）、`226843f2`、`fb70358c`。
- **fork 现状**：`crates/platform/src/macos_native_harness_broker.rs:276` 的 plist 为 `RunAtLoad true`（登录即常驻，上游实测每个约 100–120 MB）。本机目前没有注册 codexhost 的 LaunchAgent，只在远程场景相关。
- **要点**：与 process anchor 的进程所有权模型协调，不引入第二套回收逻辑。

### V25 · 上一轮遗留

- U26 Pi 子代理工作流；
- U27 DSH 新协议：上游已收敛为单一 V4 profile，并拒绝 0.1.7-rc.1 以下版本（`6b044e0f`、`fb1b753e`）；
- U29 CodeBuddy fork 与修订。

任务卡见 [上一轮 tasks.md](../upstream-comparison-20260926/tasks.md)；实施前对照上游最新实现更新卡片。

### V26 · 新 Harness

ZCode、Hermes（上游已改为 Gateway，移除 ACP）、Kimi Code、WorkBuddy、Qoder / Qoder CN。按实际需求一次选一个，排在所有现有能力治理之后。

### V00 · Codex 额度耗尽时外部 Harness 仍能发送

- **状态**：上一轮作为“额度门控”（U11）排除；2026-10-07 用户确认重新纳入，放在迭代 D，紧接 V09（两者都修改 renderer 的 binding 与 Composer 识别，交给同一个 owner 顺序完成）。
- **来源**：上游 `0cc7d3f1`（#378，首次实现）、`f7be7749`（适配 26.924：Composer 提交的所属组件外多包了一层同名 props 的透传组件）、`b401bcbf`（适配 26.928）。实现文件为 `packages/renderer-extension/src/renderer-codex-usage-gate.ts`（约 430 行），并改动 `renderer-composer-dom.ts`、`renderer-binding-probe.ts`、`contract-audit.ts`。
- **fork 现状（已核实缺失）**：fork 的 `renderer-extension` 与 `desktop-control` 中没有任何 usage gate 相关实现。Codex 订阅额度用完时，Desktop 对整个账号禁用 Composer 提交，外部 Harness 的 Composer 也一起被禁用，完全发不出消息。
- **上游做法**：Desktop 通过两个布尔 selector 阻止提交：ChatGPT 账号的 rate-limit gate，与 reserve 的 `hardBlocked` gate。两者都是账号级、只在 ChatGPT 登录时生效，并非协议限制。上游只对**外部 Harness 的那一个 Composer** 把这两个订阅投影为 `false`：
  - 不写 Account、atom 或 query 数据，Codex 原生路径和其他 Composer 保持原生结果；
  - 不影响其他原生提交限制；
  - 任何无法确认的情况都保留原生限制（fail closed）。
- **改动步骤**：
  1. 在 26.930 上确认现象：额度耗尽时，外部 Harness Composer 无法提交。可按上游测试的 fixture 方式模拟 gate，不需要真实耗尽额度。
  2. 移植 `renderer-codex-usage-gate.ts`，按 fork 的 renderer binding 结构适配（基于 V09 完成后的 `renderer-react-ownership.ts` 与 binding probe）。
  3. 只在 Composer 被识别为外部 Harness 时挂载投影；切回 Codex 或 Composer 卸载时恢复原生订阅。
  4. 吸取 26.924、26.928 两次适配的经验，加入 26.930 的组件结构探针：所属组件出现多个候选时，只取持有 reserve gate 的那个；识别失败时保持原生限制并上报诊断。
  5. 在 contract audit 中登记新增的 Desktop 私有结构依赖。
- **验收**：
  - fixture：两个 gate 为 true 时，外部 Composer 可提交，同时存在的原生 Codex Composer 仍被禁用；
  - 无法定位 gate 或候选不唯一时不投影（保持禁用），并有诊断；
  - Composer 切换、卸载、重新挂载后无残留投影；
  - 26.930 实际渲染确认。
- **风险**：依赖 Desktop 私有的 React 结构，每次 Desktop 升级都可能失效（上游已适配三次）；必须 fail closed，不能误放开 Codex 自身的额度限制。
- **许可证**：移植时在文件头注明上游来源提交。

## 5. 不借鉴

| 内容 | 原因 |
| --- | --- |
| thread watch（`a0d83850` 等，#406） | fork 已有 `thread observe`（`thread-observer.ts`），属于同一类能力 |
| 账号、额度展示与刷新、Pi 凭据导入（#489、`50168646` 等） | 按用户要求排除 |
| 其他 Harness 会话导入（`aedaec68`、`8524bef4` 中的导入部分） | 按用户要求排除 |
| CI 精简中删除不稳定测试（`695fea68`、`a35947bc`、`9cfe5c7e`） | 与 fork 的测试纪律不符；只借鉴去掉重复检查的部分 |
| 品牌图标、赞助、Star 引导、README 社群内容 | 与功能无关 |
| `codexhost update` 命令、console 默认端口变更 | fork 的安装与更新流程不同 |

## 6. 必须保留的 fork 能力

process anchor 与 owned-process API、插件 API v2 的资源能力声明、`HarnessSessionKernel`、`acp-core`、`pi-family`、`thread observe`、包与 tsconfig 的边界检查、Adapter conformance。上游均没有等价物，借鉴时改为适配 fork 合同，不替换。

## 7. 执行约定

- 每张卡单独提交，提交前跑定向测试、`tsc -b`、测试代码类型检查、`eslint`、`check-boundaries`；涉及修复的卡同时做一次反向验证（撤掉修复，确认新测试失败）。
- 高风险卡（V02、V07、V10、V20、V21、V23）完成后交独立评审。
- **许可证**：上游已改为 LGPL。搬运上游代码前，按 R1 的做法在文件头注明来源提交，并核对对应版本的许可要求。本文不作法律结论。
- 不在执行中启动或重启 Desktop、安装更新、接触真实凭据、推送或发布；这些动作需要用户另行确认。

## 8. 实施记录

| 迭代 | 卡片 | 分支 | 状态 |
| --- | --- | --- | --- |
| A | V01、V02 | `fix/official-traffic-ownership` | 已实现；首轮评审结论“修后可合”，发现已修复；复审结论“修后可合”，剩余的测试缺口与文档措辞已补齐。设计说明见 [官方流量归属](../official-traffic-ownership.md) |

迭代 A 与卡片验收的差异：

- V02 验收写的是“外部 Thread 上格式错误的 archive / metadata 仍返回 `-32602`”。实际实现中，外部 Thread 的 metadata 更新不论参数如何都返回 `-32078`（尚不支持，V10 处理）；archive / unarchive 不再单独校验，因为能定位到外部 Thread 已说明 `threadId` 合法，不存在格式错误的情形。
- V01 的“已回复后又失败”和“已转发后抛错”只有单元测试覆盖：Host 中写出回复或转发成功之后没有可能抛错的代码，无法构造集成用例。请求处理本身失败、后台工作失败两种情况有 Host 级测试。
- 评审另外发现并已修复一个早已存在的问题：带 Host 游标、同时带未知字段的 `thread/list` 会连同 Host 游标一起转发给官方；现在由 Host 以 `-32602` 拒绝。
